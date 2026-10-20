fn main() -> Result<(), Box<dyn std::error::Error>> {
    mutracer_native_probe::logging::stderr();
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 6 && !(args.len() == 7 && args[6] == "--audit-samples") {
        return Err(
            "Usage: image-diagnostics INPUT OUTPUT BACKEND(0|1) SAMPLES SEED [--audit-samples]"
                .into(),
        );
    }
    let run = if args.len() == 7 {
        mutracer_native_probe::image_diagnostics::audited
    } else {
        mutracer_native_probe::image_diagnostics::run
    };
    run(
        &std::fs::read(&args[1])?,
        std::path::Path::new(&args[2]),
        args[3].parse()?,
        args[4].parse()?,
        args[5].parse()?,
    )
}
