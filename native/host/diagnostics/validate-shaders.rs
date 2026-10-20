//! Validate every AOT-generated WGSL fixture with the native device's validator.
use std::{fs, path::Path};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    mutracer_native_probe::logging::stderr();
    let directory = std::env::args()
        .nth(1)
        .ok_or("Expected shader fixture directory")?;
    let prefix = fs::read_to_string(
        std::env::args()
            .nth(2)
            .ok_or("Expected scene constant preamble")?,
    )?;
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = pollster::block_on(instance.request_adapter(&Default::default()))?;
    let info = adapter.get_info();
    let (device, _) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("MuTracer AOT shader validation"),
        required_limits: adapter.limits(),
        ..Default::default()
    }))?;
    let mut paths = fs::read_dir(Path::new(&directory))?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<Vec<_>, _>>()?;
    paths.retain(|path| {
        path.file_name().is_some_and(|name| {
            let name = name.to_string_lossy();
            name.starts_with("features-") && name.ends_with(".native.bin")
        })
    });
    paths.sort();
    if paths.is_empty() {
        return Err("No native shader fixtures".into());
    }
    for path in &paths {
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let _shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: path.file_name().and_then(|name| name.to_str()),
            source: wgpu::ShaderSource::Wgsl(
                format!("{prefix}\n{}", fs::read_to_string(path)?).into(),
            ),
        });
        if let Some(error) = pollster::block_on(scope.pop()) {
            return Err(format!("{}: {error}", path.display()).into());
        }
    }
    println!(
        "{}",
        serde_json::json!({ "validated": paths.len(), "adapter": info.name,
        "backend": format!("{:?}", info.backend), "scope": "WGSL parse/type validation; pipeline execution is checked separately" })
    );
    Ok(())
}
