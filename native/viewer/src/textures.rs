//! Native texture editing and Poly Haven UI. Requests own their target material.
use crate::{Change, Viewer, controls, scene::Model, theme};
use anyhow::{Context, Result, ensure};
use eframe::egui;
use std::{
    collections::{HashMap, HashSet},
    io::Read,
    path::PathBuf,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    time::Duration,
};

pub const SLOTS: &[(usize, &str, &str)] = &[
    (0, "Base color", "sRGB · multiplies Color"),
    (2, "Metal / rough", "G roughness, B metalness"),
    (4, "Roughness", "Green channel"),
    (5, "Metalness", "Blue channel"),
    (1, "Normal", "Tangent space"),
    (8, "Displacement", "Red channel"),
    (3, "Emission", "Multiplies emission color"),
    (6, "Transmission", "Red channel"),
    (7, "Thin film", "Thickness"),
];
#[derive(Clone, Debug)]
struct Asset {
    id: String,
    name: String,
    categories: Vec<String>,
    tags: Vec<String>,
    downloads: u64,
}
impl Asset {
    fn matches(&self, query: &str, category: &str) -> bool {
        if !category.is_empty() && !self.categories.iter().any(|c| c == category) {
            return false;
        }
        let text = format!(
            "{} {} {} {}",
            self.id,
            self.name,
            self.categories.join(" "),
            self.tags.join(" ")
        )
        .to_lowercase();
        query
            .split_whitespace()
            .all(|w| text.contains(&w.to_lowercase()))
    }
}
#[derive(Default)]
struct Progress {
    loaded: AtomicU64,
    total: AtomicU64,
}
struct Pick {
    cancel: Arc<AtomicBool>,
    progress: Arc<Progress>,
    material: usize,
    name: String,
    id: Option<String>,
    receive: mpsc::Receiver<Result<Prepared>>,
}
struct Prepared {
    model: Model,
    slots: Vec<usize>,
    neutral: Option<(bool, bool)>,
}
#[derive(Default)]
pub struct Browser {
    pub open: bool,
    pub preset_category: usize,
    pub drop_targets: Vec<(egui::Rect, usize, usize)>,
    query: String,
    category: String,
    resolution: usize,
    displacement: bool,
    catalog: Option<Vec<Asset>>,
    catalog_request: Option<mpsc::Receiver<Result<Vec<Asset>>>>,
    catalog_error: String,
    pick: Option<Pick>,
    applied: HashMap<usize, String>,
    thumbs: HashMap<String, egui::TextureHandle>,
    previews: HashMap<(usize, usize), (std::sync::Weak<[u8]>, egui::TextureHandle)>,
    requested: HashSet<String>,
    thumb_queue: Option<mpsc::SyncSender<String>>,
    thumb_results: Option<mpsc::Receiver<(String, Result<egui::ColorImage>)>>,
}
fn agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(120)))
            .timeout_recv_body(Some(Duration::from_secs(15)))
            .build()
            .into()
    })
}
fn download(url: &str, cancel: &AtomicBool, progress: &Progress) -> Result<Vec<u8>> {
    ensure!(!cancel.load(Ordering::Relaxed), "Cancelled");
    ensure!(url.starts_with("https://"), "Expected an HTTPS texture URL");
    let mut response = agent()
        .get(url)
        .call()
        .with_context(|| format!("Could not download {url}"))?;
    let total = response.body().content_length().unwrap_or(0);
    ensure!(total <= 128 * 1024 * 1024, "Download exceeds 128 MiB");
    progress.total.fetch_add(total, Ordering::Relaxed);
    let mut bytes = Vec::new();
    let mut reader = response.body_mut().as_reader();
    let mut chunk = [0; 65536];
    loop {
        ensure!(!cancel.load(Ordering::Relaxed), "Cancelled");
        let n = reader.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        ensure!(
            bytes.len() + n <= 128 * 1024 * 1024,
            "Download exceeds 128 MiB"
        );
        bytes.extend_from_slice(&chunk[..n]);
        progress.loaded.fetch_add(n as u64, Ordering::Relaxed);
    }
    Ok(bytes)
}
fn json(url: &str, cancel: &AtomicBool) -> Result<serde_json::Value> {
    Ok(serde_json::from_slice(&download(
        url,
        cancel,
        &Progress::default(),
    )?)?)
}
fn catalog(value: &serde_json::Value) -> Result<Vec<Asset>> {
    let strings = |v: &serde_json::Value| {
        v.as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    };
    let mut assets: Vec<_> = value
        .as_object()
        .context("Invalid Poly Haven catalog")?
        .iter()
        .map(|(id, a)| Asset {
            id: id.clone(),
            name: a["name"].as_str().unwrap_or(id).into(),
            categories: strings(&a["categories"]),
            tags: strings(&a["tags"]),
            downloads: a["download_count"].as_u64().unwrap_or(0),
        })
        .collect();
    assets.sort_by(|a, b| b.downloads.cmp(&a.downloads).then(a.id.cmp(&b.id)));
    Ok(assets)
}
fn maps(files: &serde_json::Value, resolution: usize, displacement: bool) -> Vec<(usize, String)> {
    let jpg = |key: &str| {
        ["1k", "2k", "4k"][..=resolution]
            .iter()
            .rev()
            .find_map(|r| files[key][*r]["jpg"]["url"].as_str().map(str::to_owned))
    };
    let mut maps = vec![(0, jpg("Diffuse")), (1, jpg("nor_gl"))];
    if let Some(arm) = jpg("arm") {
        maps.push((2, Some(arm)));
    } else {
        maps.extend([(4, jpg("Rough")), (5, jpg("Metal"))]);
    }
    if displacement {
        maps.push((8, jpg("Displacement")));
    }
    maps.into_iter()
        .filter_map(|(slot, url)| url.map(|url| (slot, url)))
        .collect()
}
fn decode(bytes: &[u8]) -> Result<image::RgbaImage> {
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(512 * 1024 * 1024);
    reader.limits(limits);
    let image = reader.decode()?;
    ensure!(
        image.width() as u64 * image.height() as u64 <= 64 * 1024 * 1024,
        "Source image exceeds 64M pixels"
    );
    Ok(image.into_rgba8())
}
impl Browser {
    pub fn preview(
        &mut self,
        material: usize,
        slot: usize,
        texture: &crate::scene::Texture,
        ctx: &egui::Context,
    ) -> egui::TextureHandle {
        let key = (material, slot);
        if let Some((pixels, handle)) = self.previews.get(&key) {
            if pixels
                .upgrade()
                .is_some_and(|pixels| Arc::ptr_eq(&pixels, &texture.pixels))
            {
                return handle.clone();
            }
        }
        let image = image::ImageBuffer::<image::Rgba<u8>, _>::from_raw(
            texture.width,
            texture.height,
            texture.pixels.as_ref(),
        )
        .unwrap();
        let image = image::imageops::thumbnail(&image, 64, 64);
        let handle = ctx.load_texture(
            format!("texture-{material}-{slot}"),
            egui::ColorImage::from_rgba_unmultiplied(
                [image.width() as usize, image.height() as usize],
                image.as_raw(),
            ),
            egui::TextureOptions::LINEAR,
        );
        self.previews
            .insert(key, (Arc::downgrade(&texture.pixels), handle.clone()));
        handle
    }
    pub fn busy(&self) -> bool {
        self.pick.is_some()
    }
    pub fn cancel(&mut self) {
        if let Some(pick) = self.pick.take() {
            pick.cancel.store(true, Ordering::Relaxed);
        }
    }
    pub fn new_model(&mut self) {
        self.cancel();
        self.applied.clear();
        self.previews.clear();
    }
    fn start(
        &mut self,
        material: usize,
        name: String,
        id: Option<String>,
        ctx: &egui::Context,
        task: impl FnOnce(&AtomicBool, &Progress) -> Result<Prepared> + Send + 'static,
    ) {
        self.cancel();
        let cancel = Arc::new(AtomicBool::new(false));
        let progress = Arc::new(Progress::default());
        let (send, receive) = mpsc::channel();
        let ctx = ctx.clone();
        let c = cancel.clone();
        let p = progress.clone();
        std::thread::spawn(move || {
            let _ = send.send(task(&c, &p));
            ctx.request_repaint();
        });
        self.pick = Some(Pick {
            cancel,
            progress,
            material,
            name,
            id,
            receive,
        });
    }
    pub fn upload(
        &mut self,
        model: &Model,
        material: usize,
        slot: usize,
        path: PathBuf,
        ctx: &egui::Context,
    ) {
        let mut model = model.clone();
        self.start(
            material,
            path.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            None,
            ctx,
            move |cancel, _| {
                ensure!(
                    path.metadata()?.len() <= 128 * 1024 * 1024,
                    "Texture file exceeds 128 MiB"
                );
                let image = decode(&std::fs::read(path)?)?;
                ensure!(!cancel.load(Ordering::Relaxed), "Cancelled");
                model.replace_textures(material, vec![(slot, Some(image))])?;
                Ok(Prepared {
                    model,
                    slots: vec![slot],
                    neutral: None,
                })
            },
        );
    }
    fn apply(&mut self, model: &Model, material: usize, asset: &Asset, ctx: &egui::Context) {
        let id = asset.id.clone();
        let mut model = model.clone();
        let resolution = self.resolution;
        let displacement = self.displacement;
        self.start(
            material,
            asset.name.clone(),
            Some(id.clone()),
            ctx,
            move |cancel, progress| {
                let files = json(
                    &format!(
                        "https://api.polyhaven.com/files/{}",
                        percent_encoding::utf8_percent_encode(
                            &id,
                            percent_encoding::NON_ALPHANUMERIC
                        )
                    ),
                    cancel,
                )?;
                let urls = maps(&files, resolution, displacement);
                ensure!(!urls.is_empty(), "This set has no supported JPG maps");
                let rough = urls.iter().any(|(slot, _)| matches!(slot, 2 | 4));
                let mut images: Vec<_> = [0, 1, 2, 4, 5, 8].map(|slot| (slot, None)).into();
                for (slot, url) in urls {
                    let image = decode(&download(&url, cancel, progress)?)?;
                    images.iter_mut().find(|(s, _)| *s == slot).unwrap().1 = Some(image);
                }
                ensure!(!cancel.load(Ordering::Relaxed), "Cancelled");
                model.replace_textures(material, images)?;
                Ok(Prepared {
                    model,
                    slots: vec![0, 1, 2, 4, 5, 8],
                    neutral: Some((files.get("Metal").is_some(), rough)),
                })
            },
        );
    }
    fn request_catalog(&mut self, ctx: &egui::Context) {
        let (send, receive) = mpsc::channel();
        let ctx = ctx.clone();
        self.catalog_error.clear();
        std::thread::spawn(move || {
            let result = json(
                "https://api.polyhaven.com/assets?t=textures",
                &AtomicBool::new(false),
            )
            .and_then(|v| catalog(&v));
            let _ = send.send(result);
            ctx.request_repaint();
        });
        self.catalog_request = Some(receive);
    }
    fn thumbnail(&mut self, asset: &Asset, ctx: &egui::Context) -> Option<egui::TextureHandle> {
        if self.thumb_queue.is_none() {
            let (send, receive) = mpsc::sync_channel::<String>(48);
            let (results, output) = mpsc::sync_channel(48);
            let ctx = ctx.clone();
            std::thread::spawn(move || {
                while let Ok(id) = receive.recv() {
                    let image = download(&format!("https://cdn.polyhaven.com/asset_img/thumbs/{id}.png?width=256&height=256"), &AtomicBool::new(false), &Progress::default())
                    .and_then(|b| decode(&b)).map(|image| { let image = image::imageops::thumbnail(&image, 256, 256);
                        egui::ColorImage::from_rgba_unmultiplied([image.width() as usize, image.height() as usize], image.as_raw()) });
                    if results.send((id, image)).is_err() {
                        break;
                    }
                    ctx.request_repaint();
                }
            });
            self.thumb_queue = Some(send);
            self.thumb_results = Some(output);
        }
        while let Some((id, result)) = self.thumb_results.as_ref().and_then(|r| r.try_recv().ok()) {
            if let Ok(image) = result {
                if self.thumbs.len() >= 128 {
                    let key = self.thumbs.keys().next().unwrap().clone();
                    self.thumbs.remove(&key);
                    self.requested.remove(&key);
                }
                self.thumbs.insert(
                    id.clone(),
                    ctx.load_texture(id, image, egui::TextureOptions::LINEAR),
                );
            }
        }
        if !self.requested.contains(&asset.id)
            && self
                .thumb_queue
                .as_ref()
                .unwrap()
                .try_send(asset.id.clone())
                .is_ok()
        {
            self.requested.insert(asset.id.clone());
        }
        self.thumbs.get(&asset.id).cloned()
    }
}
// Same solid silhouette and view box as viewer/src/components/PolyHavenLogo.tsx,
// from Poly Haven's official logo kit. Preserve its shape and use a single color.
fn poly_haven_mark(ui: &egui::Ui, rect: egui::Rect, color: egui::Color32) {
    let points = [
        [50.407, 63.621],
        [150., 6.121],
        [249.593, 63.621],
        [249.593, 178.621],
        [150., 236.121],
        [100.204, 207.371],
        [100.204, 264.871],
        [50.407, 293.621],
        [50.407, 178.621],
        [100.204, 149.871],
        [150., 178.621],
        [199.797, 149.871],
        [199.796, 92.371],
        [150., 63.621],
        [100.204, 92.371],
    ];
    let mut mesh = egui::Mesh::default();
    for [x, y] in points {
        mesh.colored_vertex(
            rect.min + egui::vec2((x - 40.) / 220. * rect.width(), y / 300. * rect.height()),
            color,
        );
    }
    mesh.indices = vec![
        14, 0, 1, 1, 2, 3, 3, 4, 5, 5, 6, 7, 5, 7, 8, 5, 8, 9, 5, 9, 10, 3, 5, 10, 3, 10, 11, 3,
        11, 12, 1, 3, 12, 1, 12, 13, 1, 13, 14,
    ];
    ui.painter().add(egui::Shape::mesh(mesh));
}

pub fn browse_button(ui: &mut egui::Ui, open: bool) -> egui::Response {
    let label = if open {
        "Hide Poly Haven textures"
    } else {
        "Browse Poly Haven textures"
    };
    let mut button = egui::Button::new("").corner_radius(12);
    if open {
        button = button.fill(theme::ACCENT_SURFACE).stroke(egui::Stroke::new(
            1.,
            egui::Color32::from_rgba_unmultiplied(236, 150, 115, 92),
        ));
    }
    let response = ui.add_sized([ui.available_width(), 32.], button);
    let color = if open {
        egui::Color32::from_rgb(0xf6, 0xb2, 0x97)
    } else {
        theme::TEXT
    };
    let text = egui::WidgetText::from(egui::RichText::new(label).size(11.5).strong().color(color))
        .into_galley(
            ui,
            Some(egui::TextWrapMode::Truncate),
            (response.rect.width() - 42.).max(1.),
            egui::TextStyle::Button,
        );
    let mark_size = egui::vec2(14. * 220. / 300., 14.);
    let left = response.rect.center().x - (mark_size.x + 7. + text.size().x) * 0.5;
    poly_haven_mark(
        ui,
        egui::Rect::from_min_size(egui::pos2(left, response.rect.center().y - 7.), mark_size),
        color,
    );
    ui.painter().galley(
        egui::pos2(
            left + mark_size.x + 7.,
            response.rect.center().y - text.size().y * 0.5,
        ),
        text,
        color,
    );
    response.widget_info(|| {
        egui::WidgetInfo::selected(egui::WidgetType::Button, ui.is_enabled(), open, label)
    });
    response.on_hover_text(label)
}

impl Viewer {
    pub fn receive_textures(&mut self) {
        let Some(result) = self
            .texture_browser
            .pick
            .as_ref()
            .and_then(|p| p.receive.try_recv().ok())
        else {
            return;
        };
        let pick = self.texture_browser.pick.take().unwrap();
        match result {
            Ok(prepared) => {
                // Only texture operations are merged; values edited during the download survive.
                let target = &mut self.model.materials[pick.material];
                let projection = target.layers.displacement_projection;
                if let Some((metal, rough)) = prepared.neutral {
                    let previous_roughness = target.roughness;
                    crate::material_presets::presets()
                        .iter()
                        .find(|p| p.id == "white")
                        .unwrap()
                        .apply(target);
                    target.metalness = if metal { 1. } else { 0. };
                    target.roughness = if rough { 1. } else { previous_roughness };
                }
                // The request owns a snapshot of the texture table. Sampling/removal/upload cancels it.
                self.model.textures = prepared.model.textures;
                for (target, source) in self
                    .model
                    .materials
                    .iter_mut()
                    .zip(&prepared.model.materials)
                {
                    target.maps = source.maps;
                }
                if prepared.slots.contains(&8) && projection == 0 {
                    self.model.materials[pick.material]
                        .layers
                        .displacement_projection = prepared.model.materials[pick.material]
                        .layers
                        .displacement_projection;
                }
                if let Some(id) = pick.id {
                    self.texture_browser.applied.insert(pick.material, id);
                } else {
                    self.texture_browser.applied.remove(&pick.material);
                }
                self.error.clear();
                self.dirty(Change::Material);
            }
            Err(error) => self.error = format!("Could not load {}: {error:#}", pick.name),
        }
    }
    pub fn texture_browser_panel(&mut self, root: &mut egui::Ui) {
        if !self.texture_browser.open {
            return;
        }
        egui::Panel::right("texture-browser")
            .exact_size(240.)
            .resizable(false)
            .frame(theme::panel())
            .show(root, |ui| {
                ui.horizontal(|ui| {
                    ui.strong("Poly Haven textures");
                    if controls::button(ui, "Close").clicked() {
                        self.texture_browser.open = false;
                    }
                });
                ui.small(format!(
                    "Apply to {}",
                    self.model.materials[self.selected].name
                ));
                ui.add(
                    egui::TextEdit::singleline(&mut self.texture_browser.query)
                        .desired_width(ui.available_width())
                        .hint_text("Search wood, brick, fabric…"),
                )
                .on_hover_text("Search wood, brick, fabric…");
                controls::segmented(
                    ui,
                    "Resolution",
                    &mut self.texture_browser.resolution,
                    &[(0, "1K"), (1, "2K"), (2, "4K")],
                );
                ui.small(
                    ["~3 MB per set", "~12 MB per set", "~45 MB per set"]
                        [self.texture_browser.resolution],
                );
                controls::toggle(
                    ui,
                    "Download displacement map",
                    &mut self.texture_browser.displacement,
                );
                if let Some(pick) = &self.texture_browser.pick {
                    let loaded = pick.progress.loaded.load(Ordering::Relaxed) as f64 / 1048576.;
                    let total = pick.progress.total.load(Ordering::Relaxed) as f64 / 1048576.;
                    ui.small(format!("{} · {loaded:.1} / {total:.1} MB", pick.name));
                    if controls::button(ui, "Cancel download").clicked() {
                        self.texture_browser.cancel();
                    }
                }
                if self.texture_browser.catalog.is_none()
                    && self.texture_browser.catalog_request.is_none()
                    && self.texture_browser.catalog_error.is_empty()
                {
                    self.texture_browser.request_catalog(ui.ctx());
                }
                if let Some(result) = self
                    .texture_browser
                    .catalog_request
                    .as_ref()
                    .and_then(|r| r.try_recv().ok())
                {
                    self.texture_browser.catalog_request = None;
                    match result {
                        Ok(assets) => self.texture_browser.catalog = Some(assets),
                        Err(e) => self.texture_browser.catalog_error = e.to_string(),
                    }
                }
                if !self.texture_browser.catalog_error.is_empty() {
                    ui.label(&self.texture_browser.catalog_error);
                    if controls::button(ui, "Retry").clicked() {
                        self.texture_browser.request_catalog(ui.ctx());
                    }
                }
                let Some(assets) = self.texture_browser.catalog.as_ref() else {
                    ui.spinner();
                    return;
                };
                let mut counts: HashMap<&str, usize> = HashMap::new();
                for asset in assets {
                    for c in &asset.categories {
                        if !c.starts_with("collection") {
                            *counts.entry(c).or_default() += 1;
                        }
                    }
                }
                let mut categories: Vec<_> = counts.into_iter().collect();
                categories.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
                let categories: Vec<_> = categories
                    .into_iter()
                    .take(12)
                    .map(|(c, _)| c.to_owned())
                    .collect();
                let label = if self.texture_browser.category.is_empty() {
                    "All"
                } else {
                    &self.texture_browser.category
                }
                .to_owned();
                controls::select(ui, "Category", &label, |ui| {
                    ui.selectable_value(&mut self.texture_browser.category, String::new(), "All");
                    for category in categories {
                        ui.selectable_value(
                            &mut self.texture_browser.category,
                            category.clone(),
                            &category,
                        );
                    }
                });
                let shown: Vec<_> = assets
                    .iter()
                    .filter(|a| {
                        a.matches(&self.texture_browser.query, &self.texture_browser.category)
                    })
                    .cloned()
                    .collect();
                ui.small(format!("{} textures · CC0", shown.len()));
                let width = (ui.available_width() - 8.) / 2.;
                let row_height = width + 26.;
                egui::ScrollArea::vertical().show_rows(
                    ui,
                    row_height,
                    shown.len().div_ceil(2),
                    |ui, rows| {
                        for row in rows {
                            ui.horizontal(|ui| {
                                for asset in shown.iter().skip(row * 2).take(2) {
                                    let thumb = self.texture_browser.thumbnail(asset, ui.ctx());
                                    let active = self.texture_browser.applied.get(&self.selected)
                                        == Some(&asset.id);
                                    let response = ui.add_sized(
                                        [width, row_height - 4.],
                                        egui::Button::new("")
                                            .fill(theme::INPUT)
                                            .stroke(egui::Stroke::new(
                                                1.,
                                                if active { theme::ACCENT } else { theme::BORDER },
                                            ))
                                            .corner_radius(8),
                                    );
                                    if let Some(thumb) = thumb {
                                        egui::Image::from_texture(&thumb)
                                            .corner_radius(8)
                                            .paint_at(
                                                ui,
                                                egui::Rect::from_min_size(
                                                    response.rect.min,
                                                    egui::vec2(width, width),
                                                ),
                                            );
                                    }
                                    let label = egui::WidgetText::from(
                                        egui::RichText::new(&asset.name)
                                            .size(10.)
                                            .color(theme::TEXT),
                                    )
                                    .into_galley(
                                        ui,
                                        Some(egui::TextWrapMode::Truncate),
                                        (width - 12.).max(1.),
                                        egui::TextStyle::Small,
                                    );
                                    ui.painter().galley(
                                        response.rect.center_bottom()
                                            - egui::vec2(
                                                label.size().x * 0.5,
                                                12. + label.size().y * 0.5,
                                            ),
                                        label,
                                        theme::TEXT,
                                    );
                                    response.widget_info(|| {
                                        egui::WidgetInfo::labeled(
                                            egui::WidgetType::Button,
                                            true,
                                            format!("Apply {} textures", asset.name),
                                        )
                                    });
                                    if response.on_hover_text(&asset.name).clicked() {
                                        self.texture_browser.apply(
                                            &self.model,
                                            self.selected,
                                            asset,
                                            ui.ctx(),
                                        );
                                    }
                                }
                            });
                        }
                    },
                );
            });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn catalog_sort_search_and_map_fallback_match_web() {
        let assets = catalog(&json!({
            "oak": {"name":"Wood boards", "categories":["wood"], "tags":["floor"], "download_count":10},
            "brick": {"name":"Brick wall", "categories":["brick"], "download_count":20}
        })).unwrap();
        assert_eq!(assets[0].id, "brick");
        assert!(assets[1].matches("WOOD floor", "wood"));
        assert!(!assets[1].matches("WOOD floor", "brick"));
        assert!(!assets[1].matches("wood stone", ""));
        let files = json!({"Diffuse":{"1k":{"jpg":{"url":"color"}}}, "nor_gl":{"2k":{"jpg":{"url":"normal"}}},
            "arm":{"1k":{"jpg":{"url":"arm"}}}, "Rough":{"2k":{"jpg":{"url":"rough"}}},
            "Displacement":{"1k":{"jpg":{"url":"height"}}}});
        assert_eq!(
            maps(&files, 2, false),
            vec![(0, "color".into()), (1, "normal".into()), (2, "arm".into())]
        );
        assert!(maps(&files, 2, true).contains(&(8, "height".into())));
        let files =
            json!({"Rough":{"1k":{"jpg":{"url":"rough"}}},"Metal":{"1k":{"jpg":{"url":"metal"}}}});
        assert_eq!(
            maps(&files, 0, false),
            vec![(4, "rough".into()), (5, "metal".into())]
        );
    }
    #[test]
    fn texture_replacement_keeps_sampling_reclaims_pixels_and_packs_all_slots() {
        let mut model =
            Model::load(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("assets/sample.glb"))
                .unwrap();
        let image = || image::RgbaImage::from_pixel(4, 4, image::Rgba([80, 160, 220, 255]));
        model.replace_textures(0, vec![(0, Some(image()))]).unwrap();
        model.set_texture_sampling(0, 0, [2, 1], [-2., 3.]).unwrap();
        let source = model.clone();
        model
            .replace_textures(0, (0..9).map(|slot| (slot, Some(image()))).collect())
            .unwrap();
        for slot in 0..9 {
            let texture = &model.textures[model.materials[0].maps[slot] as usize];
            assert_eq!(texture.wrap, [2, 1]);
            assert_eq!(texture.scale, [-2., 3.]);
        }
        let values = crate::scene::material_values(&model.materials[0]);
        for (key, slot) in [
            ("roughnessMap", 4),
            ("metalnessMap", 5),
            ("transmissionMap", 6),
            ("thinFilmMap", 7),
            ("displacementMap", 8),
        ] {
            assert_eq!(
                values[key].as_u64().unwrap(),
                model.materials[0].maps[slot] as u64
            );
        }
        for _ in 0..260 {
            model.replace_textures(0, vec![(0, Some(image()))]).unwrap();
        }
        assert_eq!(model.textures.len(), 9);
        assert_eq!(source.textures.len(), 1); // worker snapshots retain their own pixels and IDs.
        model
            .replace_textures(0, (0..9).map(|slot| (slot, None)).collect())
            .unwrap();
        assert!(model.textures.is_empty());
        let before = model.materials[0].maps;
        assert!(model.replace_textures(0, vec![(9, Some(image()))]).is_err());
        assert_eq!(model.materials[0].maps, before);
    }
    #[test]
    fn failed_or_cancelled_requests_leave_material_untouched() {
        let mut browser = Browser::default();
        let ctx = egui::Context::default();
        browser.start(0, "stale".into(), None, &ctx, |_, _| {
            Err(anyhow::anyhow!("bad image"))
        });
        let cancelled = browser.pick.as_ref().unwrap().cancel.clone();
        browser.new_model();
        assert!(cancelled.load(Ordering::Relaxed));
        assert!(!browser.busy());
        assert!(decode(b"invalid image").is_err());
        assert!(
            download(
                "https://invalid.example",
                &AtomicBool::new(true),
                &Progress::default()
            )
            .is_err()
        );
    }
    #[test]
    #[ignore = "live Poly Haven service"]
    fn live_polyhaven_catalog_and_texture_download() {
        let cancel = AtomicBool::new(false);
        let assets =
            catalog(&json("https://api.polyhaven.com/assets?t=textures", &cancel).unwrap())
                .unwrap();
        assert!(!assets.is_empty());
        let files = json("https://api.polyhaven.com/files/wood_floor", &cancel).unwrap();
        let urls = maps(&files, 0, true);
        assert!(urls.iter().any(|(s, _)| *s == 0));
        for (_, url) in urls {
            let bytes = download(&url, &cancel, &Progress::default()).unwrap();
            assert!(decode(&bytes).is_ok());
        }
    }
}

/// Real-device contract gate, deliberately separate from tests that need no GPU/network.
pub fn smoke(path: &std::path::Path, out: &std::path::Path) -> Result<()> {
    use crate::{
        renderer::{Camera, Renderer},
        scene::{Environment, KeyLight},
    };
    std::fs::create_dir_all(out)?;
    let original = Model::load(path)?;
    let material = original.meshes[0].material;
    let size = [96, 64];
    let camera = Camera::fit(original.center, original.radius);
    let environment = Environment::default();
    let image = || {
        image::RgbaImage::from_fn(8, 8, |x, y| {
            image::Rgba([
                if (x + y) % 3 == 0 { 220 } else { 40 },
                (y * 28) as u8,
                (x * 30) as u8,
                255,
            ])
        })
    };
    for mode in [0, 1] {
        bias_oracle(&original, mode, out)?;
    }
    for mode in [0, 1] {
        let mut retained = Renderer::with_backend(mode)?;
        let mut descriptor = None;
        let mut model = original.clone();
        let mut check = |model: &Model, label: &str| -> Result<Vec<f32>> {
            retained.commit(model.update_descriptor(
                &mut descriptor,
                &camera.bytes(size),
                size,
                &environment,
                &KeyLight::default(),
            ))?;
            ensure!(
                retained.backend()?.0 == mode,
                "Requested backend {mode} unavailable: {:?}",
                retained.backend()?
            );
            let actual = retained.finish(4)?;
            let mut fresh = Renderer::with_backend(mode)?;
            fresh.commit(&model.descriptor(&camera.bytes(size), size, &environment))?;
            ensure!(
                fresh.backend()?.0 == mode,
                "Reference backend {mode} unavailable"
            );
            let expected = fresh.finish(4)?;
            ensure!(
                actual.iter().all(|v| v.is_finite())
                    && actual == expected
                    && retained.image(1)? == fresh.image(1)?
                    && retained.image(2)? == fresh.image(2)?,
                "Texture editor/fresh mismatch: {mode}/{label}"
            );
            println!("PASS editor backend {mode}: {label}");
            Ok(actual)
        };
        for preset in crate::material_presets::presets() {
            preset.apply(&mut model.materials[material]);
            check(&model, &format!("preset {}", preset.id))?;
        }
        crate::material_presets::presets()
            .iter()
            .find(|p| p.id == "white")
            .unwrap()
            .apply(&mut model.materials[material]);
        let baseline = check(&model, "no textures")?;
        for &(slot, label, _) in SLOTS {
            model.replace_textures(material, vec![(slot, Some(image()))])?;
            let m = &mut model.materials[material];
            m.roughness = 0.6;
            m.metalness = 0.5;
            m.transmission = 0.3;
            m.emission = [1., 0.5, 0.2];
            m.emission_strength = 0.2;
            m.layers.film_weight = 0.5;
            if slot == 8 {
                m.layers.displacement_scale = original.radius * 0.01;
                m.layers.displacement_bias = -original.radius * 0.005;
                // Test the viewer's automatic step and projection path too.
                m.layers.displacement_step = 0.;
                m.layers.displacement_projection = 1;
            }
            let rendered = check(&model, &format!("upload {label}"))?;
            if slot == 8 {
                crate::renderer::save(
                    &out.join(format!("displacement-{mode}.png")),
                    &rendered,
                    size,
                    0.,
                )?;
                model.materials[material].layers.displacement_scale = 0.;
                let biased = check(&model, "bias without height scale")?;
                ensure!(
                    biased.iter().all(|v| v.is_finite()),
                    "Non-finite bias output"
                );
                model.materials[material].layers.displacement_scale = original.radius * 0.01;
            }
            model.set_texture_sampling(material, slot, [2, 1], [-2., 3.])?;
            check(&model, &format!("sampling {label}"))?;
            model.replace_textures(material, vec![(slot, Some(image()))])?;
            check(&model, &format!("replace {label}"))?;
            model.replace_textures(material, vec![(slot, None)])?;
            check(&model, &format!("remove {label}"))?;
        }
        model = original.clone();
        crate::material_presets::presets()
            .iter()
            .find(|p| p.id == "white")
            .unwrap()
            .apply(&mut model.materials[material]);
        ensure!(
            check(&model, "restore")? == baseline,
            "Editor did not restore baseline"
        );
        crate::renderer::save(
            &out.join(format!("restored-{mode}.png")),
            &baseline,
            size,
            0.,
        )?;
    }
    Ok(())
}

fn bias_oracle(original: &Model, mode: u32, out: &std::path::Path) -> Result<()> {
    use crate::{
        renderer::{Camera, Renderer},
        scene::{Environment, Geometry},
    };
    use glam::{Mat4, Vec3};
    let mut model = original.clone();
    let geometry = Geometry {
        material_indices: Arc::from([]),
        min: Vec3::new(-1., -1., 0.),
        max: Vec3::new(1., 1., 0.),
        positions: vec![-1., -1., 0., 1., -1., 0., 1., 1., 0., -1., 1., 0.].into(),
        indices: vec![0, 1, 2, 0, 2, 3].into(),
        normals: [0., 0., 1.].repeat(4).into(),
        uv: [vec![0., 0., 1., 0., 1., 1., 0., 1.].into(), vec![].into()],
        colors: vec![].into(),
        tangents: vec![].into(),
    };
    model.geometries = Arc::new(vec![geometry]);
    model.meshes.truncate(1);
    model.meshes[0].geometry = 0;
    model.meshes[0].material = 0;
    model.meshes[0].transform = Mat4::IDENTITY;
    model.materials.truncate(1);
    model.materials[0].maps = [u32::MAX; 9];
    model.textures = Arc::new(vec![]);
    crate::material_presets::presets()
        .iter()
        .find(|p| p.id == "white")
        .unwrap()
        .apply(&mut model.materials[0]);
    model.replace_textures(
        0,
        vec![(
            8,
            Some(image::RgbaImage::from_pixel(
                4,
                4,
                image::Rgba([128, 128, 128, 255]),
            )),
        )],
    )?;
    model.materials[0].double_sided = true;
    model.materials[0].layers.displacement_bias = 0.125;
    let mut oracle = model.clone();
    oracle.materials[0].maps[8] = u32::MAX;
    oracle.materials[0].layers.displacement_bias = 0.;
    for p in
        Arc::make_mut(&mut Arc::make_mut(&mut oracle.geometries)[0].positions).chunks_exact_mut(3)
    {
        p[2] += 0.125;
    }
    let size = [96, 64];
    let camera = Camera::fit(Vec3::ZERO, 1.5);
    let environment = Environment::default();
    let mut actual = Renderer::with_backend(mode)?;
    let mut expected = Renderer::with_backend(mode)?;
    actual.commit(&model.descriptor(&camera.bytes(size), size, &environment))?;
    expected.commit(&oracle.descriptor(&camera.bytes(size), size, &environment))?;
    ensure!(
        actual.backend()?.0 == mode && expected.backend()?.0 == mode,
        "Bias oracle backend unavailable"
    );
    let pixels = actual.finish(4)?;
    let reference = expected.finish(4)?;
    std::fs::write(
        out.join(format!("bias-{mode}.hdr-rgba")),
        pixels
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect::<Vec<_>>(),
    )?;
    std::fs::write(
        out.join(format!("bias-reference-{mode}.hdr-rgba")),
        reference
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect::<Vec<_>>(),
    )?;
    for channel in 1..=2 {
        let a = actual.image(channel)?;
        let b = expected.image(channel)?;
        std::fs::write(
            out.join(format!("bias-{mode}-aov-{channel}.rgba")),
            a.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<_>>(),
        )?;
        std::fs::write(
            out.join(format!("bias-reference-{mode}-aov-{channel}.rgba")),
            b.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<_>>(),
        )?;
        let count = a
            .iter()
            .zip(&b)
            .filter(|(a, b)| (*a - *b).abs() > 1e-6)
            .count();
        println!("Bias backend {mode} AOV {channel}: {count} differing components");
    }
    let rmse = (pixels
        .iter()
        .zip(&reference)
        .enumerate()
        .filter(|(i, _)| i % 4 != 3)
        .map(|(_, (a, b))| ((*a as f64) - (*b as f64)).powi(2))
        .sum::<f64>()
        / (size[0] * size[1] * 3) as f64)
        .sqrt();
    // Ordinary HW triangles and procedural candidates can round hit distances
    // differently in secondary paths. Exact guides independently verify the surface.
    ensure!(
        actual.image(1)? == expected.image(1)?
            && actual.image(2)? == expected.image(2)?
            && if mode == 0 {
                pixels == reference
            } else {
                rmse < 1e-4
            },
        "Bias differs from explicitly offset plane on backend {mode} (RGB RMSE {rmse})"
    );
    println!("PASS backend {mode}: bias guides exact to explicitly offset plane; RGB RMSE {rmse}");
    Ok(())
}
