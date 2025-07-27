#!/bin/bash
set -e

echo "Installing PipeWire Volume Mixer Daemon..."

# Build in release mode
echo "Building daemon in release mode..."
cargo build --release --bin pipewire-volume-mixer-daemon

# Install the binary
echo "Installing binary..."
sudo install -m 755 target/release/pipewire-volume-mixer-daemon /usr/local/bin/

# Install the systemd service
echo "Installing systemd service..."
mkdir -p ~/.config/systemd/user/
cp pipewire-volume-mixer-daemon.service ~/.config/systemd/user/

# Create config directory
echo "Creating config directory..."
sudo mkdir -p /etc/pipewire-volume-mixer
sudo cp config.toml.example /etc/pipewire-volume-mixer/config.toml

# Reload systemd and enable service
echo "Enabling service..."
systemctl --user daemon-reload
systemctl --user enable pipewire-volume-mixer-daemon.service

echo "Installation complete!"
echo ""
echo "To start the daemon:"
echo "  systemctl --user start pipewire-volume-mixer-daemon.service"
echo ""
echo "To check status:"
echo "  systemctl --user status pipewire-volume-mixer-daemon.service"
echo ""
echo "To view logs:"
echo "  journalctl --user -u pipewire-volume-mixer-daemon.service -f"