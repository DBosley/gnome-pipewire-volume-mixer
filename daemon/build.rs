fn main() {
    // Try to link against PipeWire libraries
    match pkg_config::Config::new().atleast_version("0.3").probe("libpipewire-0.3") {
        Ok(_) => {}
        Err(e) => {
            eprintln!("Warning: PipeWire development libraries not found: {e}");
            eprintln!("Install with: sudo apt install libpipewire-0.3-dev");
            eprintln!("Continuing build anyway...");
        }
    }
}
