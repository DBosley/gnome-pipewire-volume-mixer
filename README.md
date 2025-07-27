# GNOME PipeWire Volume Mixer

A GNOME Shell extension that adds virtual audio sinks to PipeWire, allowing you to control volumes for different types of applications separately (like games, media, and voice chat).

> ⚠️ **DISCLAIMER**: This extension is VERY MUCH SO VIBE CODED by someone who's not a GNOME or Rust expert. It works on my machine™ but any usage is at your own risk. Contributions and improvements are welcome!

## Features

- **Virtual Audio Sinks**: Create separate volume controls for different application categories
- **Application Routing**: Route any application to any virtual sink
- **Persistent Settings**: Remember application routing preferences across restarts
- **Real-time Control**: Adjust volumes and mute states for each virtual sink independently
- **High Performance**: Rust daemon with shared memory for minimal overhead

## Requirements

- GNOME 40 or higher
- PipeWire audio system
- WirePlumber

## Installation

### From Release (Recommended)

1. Download the latest release from the [Releases page](https://github.com/yourusername/gnome-pipewire-volume-mixer/releases)
2. Extract the archive:
   ```bash
   tar -xzf gnome-pipewire-volume-mixer-linux-x64.tar.gz
   cd gnome-pipewire-volume-mixer
   ```
3. Run the installer:
   ```bash
   ./install.sh
   ```

### From Source

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/gnome-pipewire-volume-mixer.git
   cd gnome-pipewire-volume-mixer
   ```

2. Install build dependencies:
   ```bash
   # Ubuntu/Debian
   sudo apt install cargo pipewire libpipewire-0.3-dev pkg-config
   curl -fsSL https://bun.sh/install | bash

   # Fedora
   sudo dnf install cargo pipewire pipewire-devel pkg-config
   curl -fsSL https://bun.sh/install | bash

   # Arch
   sudo pacman -S rust pipewire pkg-config
   curl -fsSL https://bun.sh/install | bash
   ```

3. Build and install:
   ```bash
   bun install
   make daemon-build
   sudo make daemon-install
   make install
   ```

## Usage

1. After installation, restart GNOME Shell (Alt+F2, type 'r', press Enter)
2. Open the system volume menu - you'll see new sliders for Game, Media, and Chat
3. Click the dropdown arrow next to each slider to route applications
4. Applications will remember their routing even after they stop playing

## Configuration

The daemon configuration is stored in `/etc/pipewire-volume-mixer/config.toml`. You can customize the virtual sinks by editing this file.

## Troubleshooting

Check daemon status:
```bash
systemctl --user status pipewire-volume-mixer-daemon
```

View daemon logs:
```bash
journalctl --user -u pipewire-volume-mixer-daemon -f
```

## Development

### Running Tests
```bash
make test
```

### Code Quality Checks
```bash
make code-quality
```

### Building
```bash
make daemon-build  # Build daemon
npm run build      # Build extension
```

## License

GPL-3.0