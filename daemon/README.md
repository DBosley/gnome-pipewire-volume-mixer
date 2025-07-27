# PipeWire Volume Mixer Daemon

High-performance daemon for managing virtual audio sinks with PipeWire.

## Requirements

- Rust 1.70+
- PipeWire 0.3+ (and development headers)
- SystemD (for service management)

### Ubuntu/Debian
```bash
sudo apt install libpipewire-0.3-dev pkg-config
```

### Fedora
```bash
sudo dnf install pipewire-devel
```

### Arch
```bash
sudo pacman -S pipewire
```

## Building

```bash
# Debug build
cargo build

# Release build (optimized)
cargo build --release
```

## Installing

```bash
# Install daemon and systemd service
make -f ../Makefile.daemon install-service
```

## Running

### As a systemd service (recommended)
```bash
# Start the service
systemctl --user start pipewire-volume-mixer

# Enable auto-start on login
systemctl --user enable pipewire-volume-mixer

# Check status
systemctl --user status pipewire-volume-mixer

# View logs
journalctl --user -u pipewire-volume-mixer -f
```

### Manually (for debugging)
```bash
# Run with debug logging
RUST_LOG=debug ./target/release/pipewire-volume-mixer-daemon --debug --foreground
```

## Architecture

The daemon provides:
- Real-time PipeWire event monitoring
- Shared memory cache for zero-copy reads
- Unix socket for control commands
- Automatic app routing based on patterns

## Performance

- Event processing: < 1ms
- Memory usage: < 10MB
- CPU usage: < 0.1% idle
- Zero subprocess calls

## Testing

```bash
# Run tests
cargo test

# Check if daemon is running
make -f ../Makefile.daemon check-daemon

# Measure performance
../scripts/measure-performance.sh
```