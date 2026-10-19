fn main() -> Result<(), Box<dyn std::error::Error>> {
    let destination = std::env::args_os()
        .nth(1)
        .ok_or("Expected external corpus seed path")?;
    std::fs::write(destination, mutracer_native_probe::fuzzing::seed())?;
    Ok(())
}
