fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 5 {
        return Err("Usage: prepare-diagnostics INPUT OUTPUT BACKEND(0|1) ITERATIONS".into());
    }
    mutracer_native_probe::preparation_diagnostics::run(
        &std::fs::read(&args[1])?,
        std::path::Path::new(&args[2]),
        args[3].parse()?,
        args[4].parse()?,
    )
}
