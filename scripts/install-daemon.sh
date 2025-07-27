#!/bin/bash
set -e

echo "PipeWire Volume Mixer Daemon Installer"
echo "====================================="
echo ""

# Check if running as root
if [ "$EUID" -eq 0 ]; then
   echo "Don't run this script as root! It will ask for sudo when needed."
   exit 1
fi

# Check dependencies
echo "Checking dependencies..."

# Check for Rust
if ! command -v cargo &> /dev/null; then
    echo "ERROR: Rust/Cargo not found!"
    echo "Install Rust from: https://rustup.rs/"
    exit 1
fi

# Check for PipeWire dev headers
if ! pkg-config --exists libpipewire-0.3; then
    echo "WARNING: PipeWire development headers not found!"
    echo ""
    echo "Install with:"
    echo "  Ubuntu/Debian: sudo apt install libpipewire-0.3-dev"
    echo "  Fedora: sudo dnf install pipewire-devel"
    echo "  Arch: sudo pacman -S pipewire"
    echo ""
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Build daemon
echo ""
echo "Building daemon (this may take a few minutes)..."
cd "$(dirname "$0")/../daemon"

if cargo build --release; then
    echo "✓ Build successful!"
else
    echo "✗ Build failed!"
    exit 1
fi

# Install binary
echo ""
echo "Installing daemon..."
INSTALL_DIR="$HOME/.local/bin"
mkdir -p "$INSTALL_DIR"

cp target/release/pipewire-volume-mixer-daemon "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/pipewire-volume-mixer-daemon"

echo "✓ Daemon installed to $INSTALL_DIR/pipewire-volume-mixer-daemon"

# Install systemd service
echo ""
echo "Installing systemd service..."
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
mkdir -p "$SYSTEMD_USER_DIR"

cp ../systemd/pipewire-volume-mixer.service "$SYSTEMD_USER_DIR/"

# Update the service file to use local binary path
sed -i "s|/usr/local/bin/|$INSTALL_DIR/|g" "$SYSTEMD_USER_DIR/pipewire-volume-mixer.service"

systemctl --user daemon-reload

echo "✓ Systemd service installed"

# Start service
echo ""
read -p "Start the daemon now? (Y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Nn]$ ]]; then
    systemctl --user start pipewire-volume-mixer
    sleep 1
    
    if systemctl --user is-active pipewire-volume-mixer >/dev/null 2>&1; then
        echo "✓ Daemon started successfully!"
        echo ""
        echo "Enable auto-start on login with:"
        echo "  systemctl --user enable pipewire-volume-mixer"
    else
        echo "✗ Failed to start daemon!"
        echo ""
        echo "Check logs with:"
        echo "  journalctl --user -u pipewire-volume-mixer -e"
        exit 1
    fi
fi

echo ""
echo "Installation complete!"
echo ""
echo "Useful commands:"
echo "  systemctl --user status pipewire-volume-mixer   # Check status"
echo "  journalctl --user -u pipewire-volume-mixer -f   # View logs"
echo "  systemctl --user restart pipewire-volume-mixer  # Restart daemon"