//! CI skips GPU execution only when adapter discovery reports NotFound.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    match pollster::block_on(instance.request_adapter(&Default::default())) {
        Ok(adapter) => {
            let (device, queue) =
                pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
                    required_limits: adapter.limits(),
                    ..Default::default()
                }))?;
            queue.submit([]);
            device.poll(wgpu::PollType::Wait {
                submission_index: None,
                timeout: Some(std::time::Duration::from_secs(30)),
            })?;
            println!(
                "{}",
                serde_json::json!({"available":true,"adapter":adapter.get_info().name,"rayQuery":adapter.features().contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY)})
            );
        }
        Err(wgpu::RequestAdapterError::NotFound { .. }) => {
            println!("{{\"available\":false,\"reason\":\"no adapter\"}}")
        }
        Err(error) => return Err(error.into()),
    }
    Ok(())
}
