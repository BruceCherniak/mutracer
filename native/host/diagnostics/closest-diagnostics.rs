fn main() -> Result<(), Box<dyn std::error::Error>> {
    mutracer_native_probe::logging::stderr();
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 5 {
        return Err("Usage: closest-diagnostics INPUT OUTPUT SAMPLES SEED".into());
    }
    mutracer_native_probe::image_diagnostics::closest_counts(
        &std::fs::read(&args[1])?,
        std::path::Path::new(&args[2]),
        args[3].parse()?,
        args[4].parse()?,
    )
}
