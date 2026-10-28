#[test]
#[ignore = "explicit frozen HDR transfer comparison"]
fn reference_display_capture() {
    let directory = std::env::var("MUTRACER_REFERENCE_OUTPUT").unwrap();
    let gpu = GpuDevice::with_backend(0).unwrap();
    let size = [16, 16];
    let samples = 32;
    let pixels: Vec<[f64; 4]> = (0..256)
        .map(|i| {
            let value = if (i / 16 + i % 16) % 2 == 0 { 2. } else { 6. };
            [value, value * 0.5, value * 0.25, 0.6]
        })
        .collect();
    let mut display = snapshot(&gpu, size, samples, &pixels);
    let shadow = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: 256 * 48,
        usage: wgpu::BufferUsages::STORAGE
            | wgpu::BufferUsages::COPY_DST
            | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let moments: Vec<f32> = (0..256)
        .flat_map(|i| {
            let value = pixels[((15 - i / 16) * 16 + i % 16) as usize];
            let lum = (value[0] * 0.2126 + value[1] * 0.7152 + value[2] * 0.0722) as f32;
            [
                0.,
                0.,
                0.,
                0.,
                0.,
                0.,
                0.,
                0.,
                lum * 32.,
                (lum * lum + 10.) * 32.,
                0.,
                0.,
            ]
        })
        .collect();
    put(&gpu, &shadow, &moments);
    display.shadow = Some(shadow);
    let settings = Settings::default();
    let save = |name: &str, display: &mut Display| {
        let mut hdr = Vec::new();
        let mut rgba = Vec::new();
        hdr = read_half(&gpu, &display.compose_hdr(&settings));
        rgba = display.read_rgba(&settings).unwrap();
        std::fs::create_dir_all(&directory).unwrap();
        let root = std::path::Path::new(&directory);
        let floats: Vec<u8> = hdr
            .iter()
            .flatten()
            .flat_map(|v| (*v as f32).to_le_bytes())
            .collect();
        std::fs::write(root.join(format!("{name}.f32")), floats).unwrap();
        std::fs::write(root.join(format!("{name}.rgba8")), rgba).unwrap();
        hdr
    };
    let raw = save("raw", &mut display);
    display.set_jnlm(Some(crate::display::jnlm::Options {
        strength: 3.,
        ..Default::default()
    }));
    let jnlm = save("jnlm", &mut display);
    display.set_jnlm(None);
    let filtered = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: 256 * 16,
        usage: wgpu::BufferUsages::STORAGE
            | wgpu::BufferUsages::COPY_DST
            | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    put(&gpu, &filtered, &[0.25, 0.125, 0.0625, 0.6].repeat(256));
    display.upload_display_oidn(&filtered, settings).unwrap();
    let retained_display = save("retained-display", &mut display);
    assert!(
        raw.iter()
            .chain(jnlm.iter())
            .chain(retained_display.iter())
            .flatten()
            .all(|x| x.is_finite())
    );
    let layer_pixels: Vec<[f64; 4]> = pixels.iter().map(|p| [p[0], p[1], p[2], 0.5]).collect();
    let mut layered = snapshot(&gpu, size, samples, &layer_pixels);
    put(&gpu, &layered.albedo, &[6.4, 6.4, 6.4, 16.].repeat(256));
    let layers = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: 256 * 48,
        usage: wgpu::BufferUsages::STORAGE
            | wgpu::BufferUsages::COPY_DST
            | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    put(
        &gpu,
        &layers,
        &[16., 0., 0., 8., 3.2, 1.6, 0.8, 16., 0., 0., 0., 0.].repeat(256),
    );
    layered.shadow = Some(layers);
    layered.metadata = Metadata {
        has_catcher: true,
        flat_background: [0.; 4],
    };
    layered
        .upload(&[0.5, 0.25, 0.125, 0.5].repeat(256))
        .unwrap();
    let catcher_hdr = save("catcher", &mut layered);
    let catcher_sdr: Vec<[f64; 4]> = layered
        .read_rgba(&settings)
        .unwrap()
        .chunks_exact(4)
        .map(|p| [p[0] as f64, p[1] as f64, p[2] as f64, p[3] as f64])
        .collect();
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(std::path::Path::new(&directory).join("hdr.json"),serde_json::to_vec(&serde_json::json!({"raw":raw,"jnlm":jnlm,"retainedDisplay":retained_display,"catcherHDR":catcher_hdr,"catcherSDR":catcher_sdr,"source":pixels})).unwrap()).unwrap();
}
