fn main() {
    let args: Vec<_> = std::env::args().collect();
    if args.len() < 3 || args.len() > 5 {
        eprintln!("Usage: mutracer-native-probe SCENE_DIRECTORY OUTPUT_DIRECTORY [SAMPLES] [hwrt]");
        std::process::exit(2);
    }
    let samples = args
        .get(3)
        .map(|s| s.parse::<u32>().expect("Invalid sample count"))
        .unwrap_or(0);
    let flags = if args.get(4).is_some_and(|v| v == "hwrt") {
        4
    } else {
        0
    };
    if let Err(error) = mutracer_native_probe::render_options(
        std::path::Path::new(&args[1]),
        std::path::Path::new(&args[2]),
        &mutracer_native_probe::RenderOptions {
            samples,
            flags,
            ..Default::default()
        },
    ) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
