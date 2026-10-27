//! Cancellable Poly Haven HDR downloads; the current lighting survives failure.
use crate::*;
use std::{
    collections::{HashMap, HashSet},
    sync::mpsc,
};
#[derive(Clone)]
struct Asset {
    id: String,
    name: String,
    categories: Vec<String>,
    downloads: u64,
}
#[derive(Default)]
pub struct Browser {
    pub open: bool,
    query: String,
    category: String,
    pub resolution: usize,
    catalog: Vec<Asset>,
    catalog_job: Option<mpsc::Receiver<Result<Vec<Asset>>>>,
    catalog_requested: bool,
    download: Option<mpsc::Receiver<Result<(Arc<image::Rgb32FImage>, String)>>>,
    cancel: Arc<AtomicBool>,
    progress: Option<mpsc::Receiver<String>>,
    pub status: String,
    thumbs: HashMap<String, egui::TextureHandle>,
    queued: HashSet<String>,
    thumb_send: Option<mpsc::SyncSender<String>>,
    thumb_receive: Option<mpsc::Receiver<(String, Result<egui::ColorImage>)>>,
}
fn json(url: &str, cancel: &AtomicBool) -> Result<serde_json::Value> {
    Ok(serde_json::from_slice(&examples::fetch(
        url,
        cancel,
        |_, _| {},
    )?)?)
}
fn key(url: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    url.hash(&mut hash);
    format!("{:016x}", hash.finish())
}
impl Browser {
    pub fn cancel(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
        self.download = None;
        self.progress = None;
        self.status.clear();
    }
    pub fn load(&mut self, address: String, name: String, ctx: &egui::Context) {
        self.cancel();
        self.cancel = Arc::new(AtomicBool::new(false));
        let cancel = self.cancel.clone();
        let resolution = ["1k", "2k", "4k"][self.resolution];
        let (send, receive) = mpsc::channel();
        let (progress, updates) = mpsc::channel();
        let ctx = ctx.clone();
        self.status = format!("Downloading {name}…");
        self.download = Some(receive);
        self.progress = Some(updates);
        std::thread::spawn(move || {
            let result = (|| -> Result<_> {
                let url = if address.starts_with("http://") || address.starts_with("https://") {
                    address
                } else {
                    let files = json(
                        &format!("https://api.polyhaven.com/files/{address}"),
                        &cancel,
                    )?;
                    files["hdri"][resolution]["hdr"]["url"]
                        .as_str()
                        .context("HDR resolution is unavailable")?
                        .to_owned()
                };
                let folder = examples::cache_root().join("environments");
                std::fs::create_dir_all(&folder)?;
                let path = folder.join(format!("{}.hdr", key(&url)));
                if !path.is_file() {
                    let bytes = examples::fetch(&url, &cancel, |loaded, total| {
                        let _ = progress.send(format!(
                            "Downloading · {:.1} / {:.1} MB",
                            loaded as f64 / 1e6,
                            total as f64 / 1e6
                        ));
                        ctx.request_repaint();
                    })?;
                    examples::check_cancel(&cancel)?;
                    let temporary = folder.join(format!(
                        ".{}-{}.tmp",
                        key(&url),
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)?
                            .as_nanos()
                    ));
                    std::fs::write(&temporary, bytes)?;
                    std::fs::rename(temporary, &path)?;
                }
                let mut env = Environment::default();
                env.load(&path)?;
                examples::check_cancel(&cancel)?;
                Ok((env.image.unwrap(), name))
            })();
            let _ = send.send(result);
            ctx.request_repaint();
        });
    }
    fn thumbnail(&mut self, id: &str, ctx: &egui::Context) -> Option<egui::TextureHandle> {
        if self.thumb_send.is_none() {
            let (send, jobs) = mpsc::sync_channel::<String>(16);
            let (results, receive) = mpsc::channel();
            let ctx = ctx.clone();
            std::thread::spawn(move || {
                while let Ok(id) = jobs.recv() {
                    let result=examples::fetch(&format!("https://cdn.polyhaven.com/asset_img/thumbs/{id}.png?width=256&height=128"),&AtomicBool::new(false),|_,_|{}).and_then(|b|Ok(image::load_from_memory(&b)?.thumbnail(256,128).into_rgba8())).map(|i|egui::ColorImage::from_rgba_unmultiplied([i.width() as usize,i.height() as usize],i.as_raw()));
                    if results.send((id, result)).is_err() {
                        break;
                    }
                    ctx.request_repaint();
                }
            });
            self.thumb_send = Some(send);
            self.thumb_receive = Some(receive);
        }
        while let Some((id, result)) = self.thumb_receive.as_ref().and_then(|r| r.try_recv().ok()) {
            if let Ok(image) = result {
                if self.thumbs.len() >= 128 {
                    if let Some(id) = self.thumbs.keys().next().cloned() {
                        self.thumbs.remove(&id);
                        self.queued.remove(&id);
                    }
                }
                self.thumbs.insert(
                    id.clone(),
                    ctx.load_texture(id, image, egui::TextureOptions::LINEAR),
                );
            }
        }
        if !self.queued.contains(id)
            && self
                .thumb_send
                .as_ref()
                .unwrap()
                .try_send(id.into())
                .is_ok()
        {
            self.queued.insert(id.into());
        }
        self.thumbs.get(id).cloned()
    }
}
impl Drop for Browser {
    fn drop(&mut self) {
        self.cancel();
    }
}
impl Viewer {
    pub(super) fn environment_browser(&mut self, ctx: &egui::Context) {
        let browser = &mut self.environments;
        if let Some(updates) = &browser.progress {
            for message in updates.try_iter() {
                browser.status = message;
            }
        }
        let result = browser.download.as_ref().map(|receive| receive.try_recv());
        if let Some(result) = result {
            match result {
                Ok(result) => {
                    let before = crate::history::Snapshot::capture(self);
                    self.environments.download = None;
                    self.environments.progress = None;
                    self.environments.status.clear();
                    match result {
                        Ok((image, name)) => {
                            self.environment.image = Some(image);
                            self.environment.name = name;
                            self.environment.model_lighting = false;
                            self.environment.studio.enabled = false;
                            self.dirty(Change::Environment);
                        }
                        Err(e) => self.error = format!("Could not load environment: {e:#}"),
                    }
                    let after = crate::history::Snapshot::capture(self);
                    self.history.record(before, after);
                }
                Err(mpsc::TryRecvError::Empty) => {
                    ctx.request_repaint_after(Duration::from_millis(50))
                }
                Err(_) => {
                    self.environments.download = None;
                    self.error = "Environment download stopped".into();
                }
            }
        }
        let browser = &mut self.environments;
        if !browser.open {
            return;
        }
        if !browser.catalog_requested {
            browser.catalog_requested = true;
            let (send, receive) = mpsc::channel();
            let ctx = ctx.clone();
            browser.catalog_job = Some(receive);
            std::thread::spawn(move || {
                let result = json(
                    "https://api.polyhaven.com/assets?t=hdris",
                    &AtomicBool::new(false),
                )
                .and_then(|v| {
                    let mut entries: Vec<_> = v
                        .as_object()
                        .context("Invalid HDRI catalog")?
                        .iter()
                        .map(|(id, a)| Asset {
                            id: id.clone(),
                            name: a["name"].as_str().unwrap_or(id).into(),
                            categories: a["categories"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .filter_map(|v| v.as_str().map(str::to_owned))
                                .collect(),
                            downloads: a["download_count"].as_u64().unwrap_or(0),
                        })
                        .collect();
                    entries.sort_by_key(|a| std::cmp::Reverse(a.downloads));
                    Ok(entries)
                });
                let _ = send.send(result);
                ctx.request_repaint();
            });
        }
        if let Some(receive) = &browser.catalog_job {
            if let Ok(result) = receive.try_recv() {
                browser.catalog_job = None;
                match result {
                    Ok(c) => browser.catalog = c,
                    Err(e) => browser.status = format!("Could not load catalog: {e:#}"),
                }
            }
        }
        let mut open = true;
        let mut pick = None;
        egui::Window::new("Poly Haven environments")
            .open(&mut open)
            .default_width(560.)
            .default_height(620.)
            .collapsible(false)
            .show(ctx, |ui| {
                ui.horizontal(|ui| {
                    ui.hyperlink_to("Poly Haven · CC0", "https://polyhaven.com/hdris");
                    ui.add(
                        egui::TextEdit::singleline(&mut browser.query)
                            .hint_text("Search environments")
                            .desired_width(220.),
                    );
                });
                ui.horizontal(|ui| {
                    egui::ComboBox::from_id_salt("hdr-size")
                        .selected_text(["1K", "2K", "4K"][browser.resolution])
                        .show_ui(ui, |ui| {
                            for (i, n) in ["1K", "2K", "4K"].iter().enumerate() {
                                ui.selectable_value(&mut browser.resolution, i, *n);
                            }
                        });
                    egui::ComboBox::from_id_salt("hdr-category")
                        .selected_text(if browser.category.is_empty() {
                            "All categories"
                        } else {
                            &browser.category
                        })
                        .show_ui(ui, |ui| {
                            ui.selectable_value(
                                &mut browser.category,
                                String::new(),
                                "All categories",
                            );
                            let mut categories: Vec<_> = browser
                                .catalog
                                .iter()
                                .flat_map(|a| a.categories.iter().cloned())
                                .collect();
                            categories.sort();
                            categories.dedup();
                            for c in categories {
                                ui.selectable_value(&mut browser.category, c.clone(), c);
                            }
                        });
                    if browser.download.is_some() && ui.button("Cancel download").clicked() {
                        browser.cancel();
                    }
                });
                if !browser.status.is_empty() {
                    ui.label(&browser.status);
                }
                if browser.catalog.is_empty()
                    && browser.catalog_job.is_none()
                    && ui.button("Retry catalog").clicked()
                {
                    browser.catalog_requested = false;
                }
                let query = browser.query.to_lowercase();
                let entries: Vec<_> = browser
                    .catalog
                    .iter()
                    .filter(|a| {
                        (browser.category.is_empty() || a.categories.contains(&browser.category))
                            && query.split_whitespace().all(|q| {
                                format!("{} {} {}", a.id, a.name, a.categories.join(" "))
                                    .to_lowercase()
                                    .contains(q)
                            })
                    })
                    .cloned()
                    .collect();
                let columns = 3;
                egui::ScrollArea::vertical().show_rows(
                    ui,
                    116.,
                    entries.len().div_ceil(columns),
                    |ui, range| {
                        for row in range {
                            ui.horizontal(|ui| {
                                for asset in entries.iter().skip(row * columns).take(columns) {
                                    ui.vertical(|ui| {
                                        ui.set_width(164.);
                                        if let Some(texture) = browser.thumbnail(&asset.id, ctx) {
                                            if ui
                                                .add(egui::Button::image(
                                                    egui::Image::from_texture(&texture)
                                                        .fit_to_exact_size(egui::vec2(156., 78.)),
                                                ))
                                                .clicked()
                                            {
                                                pick = Some((asset.id.clone(), asset.name.clone()));
                                            }
                                        } else if ui
                                            .add_sized([156., 78.], egui::Button::new("Load"))
                                            .clicked()
                                        {
                                            pick = Some((asset.id.clone(), asset.name.clone()));
                                        }
                                        ui.add(egui::Label::new(&asset.name).truncate());
                                    });
                                }
                            });
                        }
                    },
                );
            });
        browser.open = open;
        if let Some((id, name)) = pick {
            browser.load(id, name, ctx);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "downloads a CC0 HDRI from Poly Haven"]
    fn poly_haven_hdri_download_and_cache() {
        let ctx = egui::Context::default();
        let mut browser = Browser::default();
        browser.load("studio_small_09".into(), "Studio small 09".into(), &ctx);
        let result = browser
            .download
            .take()
            .unwrap()
            .recv_timeout(Duration::from_secs(120))
            .unwrap()
            .unwrap();
        assert_eq!(result.1, "Studio small 09");
        assert!(result.0.width() > 0 && result.0.height() > 0);
        assert!(u64::from(result.0.width()) * u64::from(result.0.height()) <= 4_194_304);
        assert!(
            result
                .0
                .pixels()
                .all(|p| p.0.iter().all(|v| v.is_finite() && *v >= 0.))
        );
        browser.load("studio_small_09".into(), "Cached HDRI".into(), &ctx);
        let cached = browser
            .download
            .take()
            .unwrap()
            .recv_timeout(Duration::from_secs(120))
            .unwrap()
            .unwrap();
        assert_eq!(*cached.0, *result.0);
    }
}
