//! Independent wgpu ray-query execution probe; not MuTracer HWRT integration.
use std::{fs, path::Path, sync::mpsc, time::Duration};
use wgpu::util::DeviceExt;

const SHADER: &str = include_str!("../../ray-query-probe.wgsl");
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
fn run() -> Result<()> {
    let directory = std::env::args()
        .nth(1)
        .ok_or("Usage: ray-query-probe OUTPUT_DIRECTORY")?;
    let directory = Path::new(&directory);
    fs::create_dir_all(directory)?;
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter =
        pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))?;
    let info = adapter.get_info();
    if !adapter
        .features()
        .contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY)
    {
        fs::write(
            directory.join("result.json"),
            "{\"supported\":false,\"executed\":false}",
        )?;
        return Err("Adapter does not expose ray queries; software renderer is unaffected".into());
    }
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("MuTracer independent ray-query probe"),
        required_features: wgpu::Features::EXPERIMENTAL_RAY_QUERY,
        required_limits: adapter.limits(),
        // This opt-in is confined to the independent probe.
        experimental_features: unsafe { wgpu::ExperimentalFeatures::enabled() },
        ..Default::default()
    }))?;
    let vertices: [f32; 9] = [-1., -1., 0., 1., -1., 0., 0., 1., 0.];
    let vertex_bytes: Vec<_> = vertices.iter().flat_map(|v| v.to_le_bytes()).collect();
    let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("Ray query triangle"),
        contents: &vertex_bytes,
        usage: wgpu::BufferUsages::BLAS_INPUT,
    });
    let size = wgpu::BlasTriangleGeometrySizeDescriptor {
        vertex_format: wgpu::VertexFormat::Float32x3,
        vertex_count: 3,
        index_format: None,
        index_count: None,
        flags: wgpu::AccelerationStructureGeometryFlags::OPAQUE,
    };
    let blas = device.create_blas(
        &wgpu::CreateBlasDescriptor {
            label: Some("Ray query BLAS"),
            flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
            update_mode: wgpu::AccelerationStructureUpdateMode::Build,
        },
        wgpu::BlasGeometrySizeDescriptors::Triangles {
            descriptors: vec![size.clone()],
        },
    );
    let mut tlas = device.create_tlas(&wgpu::CreateTlasDescriptor {
        label: Some("Ray query TLAS"),
        max_instances: 3,
        flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
        update_mode: wgpu::AccelerationStructureUpdateMode::Build,
    });
    for (index, (x, z, custom, mask)) in [(0., 0., 17, 1), (3., 1., 29, 2), (0., 1., 31, 4)]
        .into_iter()
        .enumerate()
    {
        tlas[index] = Some(wgpu::TlasInstance::new(
            &blas,
            [1., 0., 0., x, 0., 1., 0., 0., 0., 0., 1., z],
            custom,
            mask,
        ));
    }
    let rays: [[f32; 8]; 8] = [
        [0., 0., 2., 10., 0., 0., -1., 255.], // nearest of overlapping instances
        [0., 0., 2., 10., 0., 0., -1., 1.],   // mask selects farther instance
        [3., 0., 3., 10., 0., 0., -1., 255.], // translated instance
        [3., 0., 3., 10., 0., 0., -1., 1.],   // translated instance masked out
        [0., 0., 2., 0.5, 0., 0., -1., 255.], // finite tmax
        [0., 0., -2., 10., 0., 0., 1., 255.], // back face, no culling flag
        [0., 0., 2., 10., 0., 0., -1., 4.],
        [2., 0., 3., 10., 0., 0., -1., 255.], // geometric miss
    ];
    let input_bytes: Vec<_> = rays
        .iter()
        .flatten()
        .flat_map(|v| v.to_le_bytes())
        .collect();
    let inputs = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("Ray query analytic fixtures"),
        contents: &input_bytes,
        usage: wgpu::BufferUsages::STORAGE,
    });
    let results = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Ray query results"),
        size: 8 * 32,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Ray query readback"),
        size: results.size(),
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Ray query verification"),
        source: wgpu::ShaderSource::Wgsl(SHADER.into()),
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("Ray query verification"),
        layout: None,
        module: &module,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    });
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("Ray query resources"),
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: tlas.as_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: inputs.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: results.as_entire_binding(),
            },
        ],
    });
    let build = wgpu::BlasBuildEntry {
        blas: &blas,
        geometry: wgpu::BlasGeometries::TriangleGeometries(vec![wgpu::BlasTriangleGeometry {
            size: &size,
            vertex_buffer: &vertex_buffer,
            first_vertex: 0,
            vertex_stride: 12,
            index_buffer: None,
            first_index: None,
            transform_buffer: None,
            transform_buffer_offset: None,
        }]),
    };
    let mut encoder = device.create_command_encoder(&Default::default());
    encoder.build_acceleration_structures([&build], [&tlas]);
    {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(1, 1, 1);
    }
    encoder.copy_buffer_to_buffer(&results, 0, &readback, 0, results.size());
    queue.submit([encoder.finish()]);
    let (sender, receiver) = mpsc::channel();
    readback
        .slice(..)
        .map_async(wgpu::MapMode::Read, move |value| {
            let _ = sender.send(value);
        });
    device.poll(wgpu::PollType::Wait {
        submission_index: None,
        timeout: Some(Duration::from_secs(30)),
    })?;
    receiver.recv_timeout(Duration::from_secs(5))??;
    let mapped = readback.slice(..).get_mapped_range()?;
    fs::write(directory.join("results.bin"), &mapped)?;
    let expected = [
        (true, 1., 31.),
        (true, 2., 17.),
        (true, 2., 29.),
        (false, 0., 0.),
        (false, 0., 0.),
        (true, 2., 17.),
        (true, 1., 31.),
        (false, 0., 0.),
    ];
    let mut observations = Vec::new();
    for (index, (bytes, (hit, distance, custom))) in
        mapped.chunks_exact(32).zip(expected).enumerate()
    {
        let values: Vec<_> = bytes
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
            .collect();
        if (values[0] != 0.) != hit
            || (hit
                && ((values[1] - distance).abs() > 1e-5
                    || values[2] != custom
                    || values[3] != 0.
                    || (values[4] - 0.25).abs() > 1e-5
                    || (values[5] - 0.5).abs() > 1e-5))
        {
            return Err(format!("Ray fixture {index} mismatch: {values:?}").into());
        }
        observations.push(values);
    }
    let summary = serde_json::json!({ "adapter": info.name, "backend": format!("{:?}", info.backend),
        "supported": true, "executed": true, "blasCount": 1, "tlasInstances": 3,
        "verifiedRays": 8, "observations": observations,
        "scope": "independent opaque triangle ray-query probe; MuTracer still uses software traversal" });
    fs::write(
        directory.join("result.json"),
        serde_json::to_vec_pretty(&summary)?,
    )?;
    println!("{}", serde_json::to_string_pretty(&summary)?);
    Ok(())
}
