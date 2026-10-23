use super::*;
#[test]
fn surface_options_negotiate_supported_sdr_and_reject_invalid_requests() {
    let caps = wgpu::SurfaceCapabilities {
        formats: vec![
            wgpu::TextureFormat::Rgba16Float,
            wgpu::TextureFormat::Bgra8Unorm,
            wgpu::TextureFormat::Rgba8UnormSrgb,
        ],
        present_modes: vec![wgpu::PresentMode::Fifo],
        alpha_modes: vec![wgpu::CompositeAlphaMode::PreMultiplied],
        ..Default::default()
    };
    let options = SurfaceOptions::default();
    let config = configuration(&caps, &options, [320, 240]).unwrap();
    assert_eq!(config.format, wgpu::TextureFormat::Rgba8UnormSrgb);
    assert_eq!(config.alpha_mode, wgpu::CompositeAlphaMode::PreMultiplied);
    assert_eq!(config.color_space, wgpu::SurfaceColorSpace::Auto);
    assert!(configuration(&caps, &options, [0, 240]).is_err());
    assert!(configuration(&wgpu::SurfaceCapabilities::default(), &options, [320, 240]).is_err());
    for options in [
        SurfaceOptions {
            format: Some(wgpu::TextureFormat::Rgba16Float),
            ..Default::default()
        },
        SurfaceOptions {
            format: Some(wgpu::TextureFormat::Rgba8Unorm),
            ..Default::default()
        },
        SurfaceOptions {
            alpha_mode: wgpu::CompositeAlphaMode::PostMultiplied,
            ..Default::default()
        },
        SurfaceOptions {
            present_mode: wgpu::PresentMode::Mailbox,
            ..Default::default()
        },
        SurfaceOptions {
            desired_maximum_frame_latency: 0,
            ..Default::default()
        },
    ] {
        assert_eq!(
            configuration(&caps, &options, [320, 240])
                .unwrap_err()
                .status,
            Status::InvalidArgument
        );
    }
    let fallback = configuration(
        &caps,
        &SurfaceOptions {
            present_mode: wgpu::PresentMode::AutoNoVsync,
            ..Default::default()
        },
        [320, 240],
    )
    .unwrap();
    assert_eq!(fallback.present_mode, wgpu::PresentMode::Fifo);
    let (sdr, reason) = negotiate(&caps, &options, [320, 240], true).unwrap();
    assert_ne!(sdr.format, wgpu::TextureFormat::Rgba16Float);
    assert!(reason.is_some());
    let mut caps = caps;
    caps.format_capabilities
        .push(wgpu::SurfaceFormatCapabilities {
            format: wgpu::TextureFormat::Rgba16Float,
            color_spaces: wgpu::SurfaceColorSpaces::EXTENDED_SRGB_LINEAR,
        });
    let (hdr, reason) = negotiate(&caps, &options, [320, 240], true).unwrap();
    assert_eq!(hdr.format, wgpu::TextureFormat::Rgba16Float);
    assert_eq!(hdr.color_space, wgpu::SurfaceColorSpace::ExtendedSrgbLinear);
    assert!(reason.is_none());
    let old_formats = std::mem::take(&mut caps.formats);
    assert_eq!(
        negotiate(&caps, &options, [320, 240], true)
            .unwrap()
            .0
            .format,
        wgpu::TextureFormat::Rgba16Float
    );
    assert!(negotiate(&caps, &options, [320, 240], false).is_err());
    caps.formats = old_formats;

    let (pinned, reason) = negotiate(
        &caps,
        &SurfaceOptions {
            format: Some(wgpu::TextureFormat::Bgra8Unorm),
            ..Default::default()
        },
        [320, 240],
        true,
    )
    .unwrap();
    assert_eq!(pinned.format, wgpu::TextureFormat::Bgra8Unorm);
    assert!(reason.unwrap().contains("explicit SDR"));
}
#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn surface_sdr_blit_preserves_encoded_pixels_orientation_and_alpha_modes() {
    let engine = crate::api::Engine::new(crate::api::EngineOptions {
        backend: crate::api::Backend::Software,
    })
    .unwrap();
    let gpu = engine.inner.gpu.clone();
    let size = [8, 4];
    let pixels: Vec<u8> = (0..32)
        .flat_map(|i| {
            let a = [0u8, 64, 128, 255][i % 4];
            [((i * 7) as u16 * a as u16 / 255) as u8, a / 2, a / 4, a]
        })
        .collect();
    let source = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d {
            width: size[0],
            height: size[1],
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    gpu.queue.write_texture(
        source.as_image_copy(),
        &pixels,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(size[0] * 4),
            rows_per_image: None,
        },
        source.size(),
    );
    let reader = crate::display::Display::new(gpu.clone(), size);
    for format in FORMATS {
        for alpha in [
            wgpu::CompositeAlphaMode::Opaque,
            wgpu::CompositeAlphaMode::PreMultiplied,
            wgpu::CompositeAlphaMode::PostMultiplied,
        ] {
            let target = gpu.device.create_texture(&wgpu::TextureDescriptor {
                label: None,
                size: source.size(),
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
                view_formats: &[],
            });
            SurfaceBlit::new(&gpu.device, format, alpha).draw(
                &gpu,
                &source,
                &target.create_view(&Default::default()),
            );
            let bytes = reader.read_image(&target).unwrap();
            for (actual, expected) in bytes.chunks_exact(4).zip(pixels.chunks_exact(4)) {
                let mut actual: [u8; 4] = actual.try_into().unwrap();
                if matches!(
                    format,
                    wgpu::TextureFormat::Bgra8Unorm | wgpu::TextureFormat::Bgra8UnormSrgb
                ) {
                    actual.swap(0, 2);
                }
                for c in 0..4 {
                    let want = if c == 3 && alpha == wgpu::CompositeAlphaMode::Opaque {
                        255.
                    } else if c < 3 && alpha == wgpu::CompositeAlphaMode::PostMultiplied {
                        if expected[3] == 0 {
                            0.
                        } else {
                            expected[c] as f32 / expected[3] as f32 * 255.
                        }
                    } else {
                        expected[c] as f32
                    };
                    assert!(
                        (actual[c] as f32 - want).abs() <= 1.1,
                        "{format:?} {alpha:?}: {actual:?} != {expected:?}"
                    );
                }
            }
        }
    }
    let source = crate::display::image(&gpu.device, size, wgpu::TextureFormat::Rgba16Float);
    let view = source.create_view(&Default::default());
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    {
        let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color {
                        r: 4.,
                        g: 1.,
                        b: 0.5,
                        a: 0.5,
                    }),
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        });
    }
    gpu.queue.submit([encoder.finish()]);
    for (alpha, want) in [
        (
            wgpu::CompositeAlphaMode::PreMultiplied,
            [0x4400u16, 0x3c00, 0x3800, 0x3800],
        ),
        (
            wgpu::CompositeAlphaMode::PostMultiplied,
            [0x4800, 0x4000, 0x3c00, 0x3800],
        ),
        (
            wgpu::CompositeAlphaMode::Opaque,
            [0x4400, 0x3c00, 0x3800, 0x3c00],
        ),
    ] {
        let target = crate::display::image(&gpu.device, size, wgpu::TextureFormat::Rgba16Float);
        SurfaceBlit::new(&gpu.device, wgpu::TextureFormat::Rgba16Float, alpha).draw(
            &gpu,
            &source,
            &target.create_view(&Default::default()),
        );
        let expected: Vec<_> = want.into_iter().flat_map(u16::to_le_bytes).collect();
        for p in crate::api::gpu_output_tests::bytes(&engine, &target, 8).chunks_exact(8) {
            assert_eq!(p, expected);
        }
    }
}
