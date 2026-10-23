use super::*;
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn fixture() -> (Engine, Render) {
    let engine = Engine::new(EngineOptions {
        backend: Backend::Software,
    })
    .unwrap();
    engine.display().set_size(9, 6).unwrap();
    engine.set_scene(&crate::scene::tests::input()).unwrap();
    engine.update().unwrap();
    let render = Render::new(
        &engine,
        RenderSettings {
            max_samples: 2,
            ..Default::default()
        },
    )
    .unwrap();
    (engine, render)
}
fn bytes(engine: &Engine, texture: &wgpu::Texture, channels: u32) -> Vec<u8> {
    let gpu = &engine.inner.gpu;
    let stride = (texture.width() * channels).div_ceil(256) * 256;
    let buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: stride as u64 * texture.height() as u64,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    encoder.copy_texture_to_buffer(
        texture.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(stride),
                rows_per_image: None,
            },
        },
        texture.size(),
    );
    gpu.queue.submit([encoder.finish()]);
    let (send, receive) = std::sync::mpsc::channel();
    buffer.map_async(wgpu::MapMode::Read, .., move |result| {
        let _ = send.send(result);
    });
    gpu.device
        .poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout: Some(Duration::from_secs(10)),
        })
        .unwrap();
    receive
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .unwrap();
    let mapped = buffer.get_mapped_range(..).unwrap();
    mapped
        .chunks_exact(stride as usize)
        .flat_map(|row| row[..(texture.width() * channels) as usize].iter().copied())
        .collect()
}
fn color_pass(context: PostProcessContext<'_>, color: wgpu::Color) -> Result<()> {
    let view = context.output.create_view(&Default::default());
    let _pass = context
        .encoder
        .begin_render_pass(&wgpu::RenderPassDescriptor {
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(color),
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        });
    Ok(())
}
#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn gpu_output_borrows_and_ordered_passes_cover_export_fallback_and_lifecycle() {
    let _lock = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let (engine, render) = fixture();
    assert!(
        render
            .get_output_texture(OutputKind::Hdr)
            .unwrap()
            .is_none()
    );
    render.converge(ConvergeOptions::new(2)).unwrap();
    let hdr = bytes(
        &engine,
        &render.get_output_texture(OutputKind::Hdr).unwrap().unwrap(),
        16,
    );
    let raw = render.read_pixels(PixelKind::Hdr).unwrap();
    assert!(
        render
            .get_output_texture(OutputKind::Display)
            .unwrap()
            .is_none()
    );
    let display = engine.display();
    let original = display.read_rgba8(&render).unwrap().2;
    assert_eq!(
        bytes(
            &engine,
            &render
                .get_output_texture(OutputKind::Display)
                .unwrap()
                .unwrap(),
            4
        ),
        original
    );
    let seen = Arc::new(Mutex::new(Vec::new()));
    let a = seen.clone();
    let first = display
        .add_post_process(move |context| {
            assert_eq!((context.width, context.height), (9, 6));
            assert_eq!(context.render.settings()?.max_samples, 2); // engine lock is free
            a.lock().unwrap().push(1);
            color_pass(
                context,
                wgpu::Color {
                    r: 0.25,
                    g: 0.5,
                    b: 0.75,
                    a: 0.5,
                },
            )
        })
        .unwrap();
    let b = seen.clone();
    let second = display
        .add_post_process(move |context| {
            b.lock().unwrap().push(2);
            context.encoder.copy_texture_to_texture(
                context.input.as_image_copy(),
                context.output.as_image_copy(),
                context.input.size(),
            );
            Ok(())
        })
        .unwrap();
    assert_eq!(
        display.read_rgba8(&render).unwrap().2,
        [64, 128, 191, 128].repeat(54)
    );
    assert_eq!(*seen.lock().unwrap(), [1, 2]);
    display.set_size(18, 12).unwrap();
    let pending = Render::new(&engine, RenderSettings::default()).unwrap();
    pending.set_fallback(Some(&render)).unwrap();
    assert!(display.present(&pending).unwrap().unwrap().fallback);
    let presentation = bytes(&engine, &display.texture().unwrap(), 4);
    for rgba in presentation.chunks_exact(4) {
        for (actual, expected) in rgba.iter().zip([32u8, 64, 96, 128]) {
            assert!(actual.abs_diff(expected) <= 1);
        }
    }
    assert_eq!(
        bytes(
            &engine,
            &render
                .get_output_texture(OutputKind::Display)
                .unwrap()
                .unwrap(),
            4
        ),
        [64, 128, 191, 128].repeat(54)
    );
    assert_eq!(
        bytes(
            &engine,
            &render.get_output_texture(OutputKind::Hdr).unwrap().unwrap(),
            16
        ),
        hdr
    );
    assert_eq!(render.read_pixels(PixelKind::Hdr).unwrap(), raw); // never touches accumulation
    first.remove();
    first.remove();
    drop(second);
    assert_eq!(display.read_rgba8(&render).unwrap().2, original);
    let edge = display
        .add_post_process(|ctx| {
            let stride = 256usize;
            let buffer = ctx.device.create_buffer(&wgpu::BufferDescriptor {
                label: None,
                size: (stride * ctx.height as usize) as u64,
                usage: wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: true,
            });
            {
                let mut mapped = buffer.get_mapped_range_mut(..).unwrap();
                for y in 0..ctx.height as usize {
                    for x in 0..ctx.width as usize {
                        mapped
                            .slice(y * stride + x * 4..y * stride + x * 4 + 4)
                            .copy_from_slice(if x < 4 {
                                &[255, 0, 0, 255]
                            } else {
                                &[0, 0, 255, 0]
                            });
                    }
                }
            }
            buffer.unmap();
            ctx.encoder.copy_buffer_to_texture(
                wgpu::TexelCopyBufferInfo {
                    buffer: &buffer,
                    layout: wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(stride as u32),
                        rows_per_image: None,
                    },
                },
                ctx.output.as_image_copy(),
                ctx.output.size(),
            );
            Ok(())
        })
        .unwrap();
    display.present(&render).unwrap();
    let scaled = bytes(&engine, &display.texture().unwrap(), 4);
    assert!(scaled.chunks_exact(4).any(|p| p[3] > 0 && p[3] < 255));
    for pixel in scaled.chunks_exact(4) {
        assert_eq!(pixel[1], 0);
        assert_eq!(pixel[2], 0);
        assert_eq!(pixel[0], pixel[3]);
    }
    drop(edge);
    render.restart().unwrap();
    assert!(
        render
            .get_output_texture(OutputKind::Hdr)
            .unwrap()
            .is_none()
    );
    assert!(
        render
            .get_output_texture(OutputKind::Display)
            .unwrap()
            .is_none()
    );
    render
        .set_settings(RenderSettings {
            size: RenderSize::Fixed {
                width: 5,
                height: 3,
            },
            ..Default::default()
        })
        .unwrap();
    render.converge(ConvergeOptions::new(1)).unwrap();
    let texture = render.get_output_texture(OutputKind::Hdr).unwrap().unwrap();
    assert_eq!((texture.width(), texture.height()), (5, 3));
    let mut settings = render.settings().unwrap();
    settings.max_samples = 1;
    render.set_settings(settings).unwrap();
    let render = Arc::new(render);
    let mut render_loop = RenderLoop::new(
        &engine,
        RenderLoopOptions {
            preview: None,
            final_render: LoopRender::Render(render.clone()),
            ..Default::default()
        },
    )
    .unwrap();
    render_loop.converge(ConvergeOptions::new(1)).unwrap();
    render_loop.tick().unwrap();
    assert!(!render_loop.needs_tick());
    let pass = display
        .add_post_process(|ctx| color_pass(ctx, wgpu::Color::BLUE))
        .unwrap();
    assert!(render_loop.needs_tick());
    render_loop.tick().unwrap();
    assert_eq!(render.samples(), 1);
    assert!(!render_loop.needs_tick());
    drop(pass);
    assert!(render_loop.needs_tick());
    render_loop.tick().unwrap();
    assert_eq!(render.samples(), 1);
    engine.device_loss_notifier().notify("output borrow loss");
    assert_eq!(
        render
            .get_output_texture(OutputKind::Hdr)
            .unwrap_err()
            .status,
        Status::Unavailable
    );
    engine.dispose();
    assert_eq!(
        render
            .get_output_texture(OutputKind::Display)
            .unwrap_err()
            .status,
        Status::InvalidHandle
    );
}
#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn gpu_output_pass_failure_discards_commands_and_allows_callback_reentry() {
    let _lock = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let (engine, render) = fixture();
    render.converge(ConvergeOptions::new(2)).unwrap();
    let display = engine.display();
    let original = display.read_rgba8(&render).unwrap().2;
    let events = Arc::new(Mutex::new(Vec::new()));
    let stored = events.clone();
    let callback_engine = engine.clone();
    let _events = engine.on(move |event| {
        if let EngineEvent::Error { .. } = event {
            // Error delivery occurs after the processing guard has been released.
            assert!(!callback_engine.lock().display.processing);
            stored.lock().unwrap().push(event.clone());
        }
    });
    let first = display
        .add_post_process(|ctx| color_pass(ctx, wgpu::Color::RED))
        .unwrap();
    for panic in [false, true] {
        let failing = display
            .add_post_process(move |ctx| {
                assert_eq!(
                    ctx.render
                        .get_output_texture(OutputKind::Display)
                        .unwrap_err()
                        .status,
                    Status::InvalidState
                );
                assert_eq!(
                    ctx.render
                        .engine()
                        .display()
                        .read_rgba8(ctx.render)
                        .unwrap_err()
                        .status,
                    Status::InvalidState
                );
                color_pass(ctx, wgpu::Color::GREEN)?;
                if panic {
                    panic!("intentional pass panic");
                }
                Err(super::error(Status::Error, "intentional pass failure"))
            })
            .unwrap();
        assert_eq!(display.read_rgba8(&render).unwrap().2, original);
        assert_eq!(
            bytes(
                &engine,
                &render
                    .get_output_texture(OutputKind::Display)
                    .unwrap()
                    .unwrap(),
                4
            ),
            original
        );
        drop(failing);
    }
    assert_eq!(events.lock().unwrap().len(), 2);
    drop(first);
    let changed = display
        .add_post_process(|ctx| {
            ctx.render.restart()?;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        display.present(&render).unwrap_err().status,
        Status::InvalidState
    );
    drop(changed);
    render.converge(ConvergeOptions::new(1)).unwrap();
    assert!(display.present(&render).unwrap().is_some());
    let loss = engine.device_loss_notifier();
    let _lost = display
        .add_post_process(move |_| {
            loss.notify("loss while recording display pass");
            Ok(())
        })
        .unwrap();
    assert_eq!(
        display.present(&render).unwrap_err().status,
        Status::Unavailable
    );
    engine.dispose();
}
