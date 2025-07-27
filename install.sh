#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_info() {
    echo -e "ℹ $1"
}

# Function to check if running with sudo
check_sudo() {
    if [ "$EUID" -eq 0 ]; then
        print_error "Please don't run this script with sudo!"
        print_info "The script will ask for sudo password when needed."
        exit 1
    fi
}

# Function to detect Linux distribution
detect_distro() {
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        DISTRO=$ID
        DISTRO_LIKE=$ID_LIKE
    else
        print_error "Cannot detect Linux distribution"
        exit 1
    fi
}

# Function to check GNOME version
check_gnome_version() {
    print_info "Checking GNOME version..."
    
    if ! command -v gnome-shell &> /dev/null; then
        print_error "GNOME Shell is not installed"
        exit 1
    fi
    
    GNOME_VERSION=$(gnome-shell --version | awk '{print $3}')
    GNOME_MAJOR=$(echo $GNOME_VERSION | cut -d. -f1)
    GNOME_MINOR=$(echo $GNOME_VERSION | cut -d. -f2)
    
    print_info "Found GNOME Shell version: $GNOME_VERSION"
    
    # Check if GNOME version is 40 or higher
    if [ "$GNOME_MAJOR" -lt 40 ]; then
        print_error "This extension requires GNOME 40 or higher"
        print_info "Your version: $GNOME_VERSION"
        exit 1
    fi
    
    print_success "GNOME version is compatible"
}

# Function to check if a command exists
command_exists() {
    command -v "$1" &> /dev/null
}

# Function to install packages based on distro
install_packages() {
    local packages=("$@")
    
    case "$DISTRO" in
        ubuntu|debian|pop|linuxmint)
            print_info "Installing packages for Debian-based system..."
            sudo apt update
            sudo apt install -y "${packages[@]}"
            ;;
        fedora)
            print_info "Installing packages for Fedora..."
            sudo dnf install -y "${packages[@]}"
            ;;
        arch|manjaro|endeavouros)
            print_info "Installing packages for Arch-based system..."
            sudo pacman -S --needed --noconfirm "${packages[@]}"
            ;;
        opensuse*)
            print_info "Installing packages for openSUSE..."
            sudo zypper install -y "${packages[@]}"
            ;;
        *)
            print_error "Unsupported distribution: $DISTRO"
            print_info "Please install the following packages manually:"
            printf '%s\n' "${packages[@]}"
            exit 1
            ;;
    esac
}

# Function to check and install system dependencies
check_dependencies() {
    print_info "Checking system dependencies..."
    
    local missing_deps=()
    local package_names=()
    
    # Check for PipeWire
    if ! command_exists pipewire; then
        print_warning "PipeWire not found"
        case "$DISTRO" in
            ubuntu|debian|pop|linuxmint) package_names+=("pipewire" "pipewire-pulse" "wireplumber") ;;
            fedora) package_names+=("pipewire" "pipewire-pulseaudio" "wireplumber") ;;
            arch|manjaro|endeavouros) package_names+=("pipewire" "pipewire-pulse" "wireplumber") ;;
            opensuse*) package_names+=("pipewire" "pipewire-pulseaudio" "wireplumber") ;;
        esac
    else
        print_success "PipeWire is installed"
    fi
    
    # Check for pactl (PulseAudio compatibility layer)
    if ! command_exists pactl; then
        print_warning "pactl not found"
        case "$DISTRO" in
            ubuntu|debian|pop|linuxmint) package_names+=("pulseaudio-utils") ;;
            fedora) package_names+=("pulseaudio-utils") ;;
            arch|manjaro|endeavouros) package_names+=("libpulse") ;;
            opensuse*) package_names+=("pulseaudio-utils") ;;
        esac
    else
        print_success "pactl is installed"
    fi
    
    # Check for wpctl (WirePlumber control)
    if ! command_exists wpctl; then
        print_warning "wpctl not found"
        case "$DISTRO" in
            ubuntu|debian|pop|linuxmint) package_names+=("wireplumber") ;;
            fedora) package_names+=("wireplumber") ;;
            arch|manjaro|endeavouros) package_names+=("wireplumber") ;;
            opensuse*) package_names+=("wireplumber") ;;
        esac
    else
        print_success "wpctl is installed"
    fi
    
    # Check for Rust/Cargo
    if ! command_exists cargo; then
        print_warning "Rust/Cargo not found"
        case "$DISTRO" in
            ubuntu|debian|pop|linuxmint) package_names+=("cargo" "rustc" "pkg-config" "libssl-dev") ;;
            fedora) package_names+=("cargo" "rust" "pkg-config" "openssl-devel") ;;
            arch|manjaro|endeavouros) package_names+=("rust" "pkg-config" "openssl") ;;
            opensuse*) package_names+=("cargo" "rust" "pkg-config" "libopenssl-devel") ;;
        esac
    else
        print_success "Rust/Cargo is installed"
    fi
    
    # Check for Node.js/npm
    if ! command_exists node || ! command_exists npm; then
        print_warning "Node.js/npm not found"
        case "$DISTRO" in
            ubuntu|debian|pop|linuxmint) package_names+=("nodejs" "npm") ;;
            fedora) package_names+=("nodejs" "npm") ;;
            arch|manjaro|endeavouros) package_names+=("nodejs" "npm") ;;
            opensuse*) package_names+=("nodejs" "npm") ;;
        esac
    else
        print_success "Node.js/npm is installed"
    fi
    
    # Check for make
    if ! command_exists make; then
        print_warning "make not found"
        case "$DISTRO" in
            ubuntu|debian|pop|linuxmint) package_names+=("build-essential") ;;
            fedora) package_names+=("make" "gcc" "gcc-c++") ;;
            arch|manjaro|endeavouros) package_names+=("base-devel") ;;
            opensuse*) package_names+=("make" "gcc" "gcc-c++") ;;
        esac
    else
        print_success "make is installed"
    fi
    
    # Check for git (in case they downloaded as zip)
    if ! command_exists git; then
        print_warning "git not found"
        package_names+=("git")
    else
        print_success "git is installed"
    fi
    
    # Install missing packages
    if [ ${#package_names[@]} -gt 0 ]; then
        print_info "Installing missing dependencies..."
        install_packages "${package_names[@]}"
    else
        print_success "All system dependencies are installed"
    fi
}

# Function to check if pre-built binary exists
check_prebuilt() {
    print_info "Checking for pre-built daemon binary..."
    
    if [ ! -f daemon/pipewire-volume-mixer-daemon ]; then
        print_error "Pre-built daemon binary not found at daemon/pipewire-volume-mixer-daemon"
        print_info "Please download the release package or build from source"
        exit 1
    fi
    
    # Make sure it's executable
    chmod +x daemon/pipewire-volume-mixer-daemon
    print_success "Pre-built daemon binary found"
}

# Function to install the daemon
install_daemon() {
    print_info "Installing the daemon..."
    
    # Install the binary
    sudo install -m 755 daemon/pipewire-volume-mixer-daemon /usr/local/bin/
    print_success "Daemon binary installed"
    
    # Create config directory
    sudo mkdir -p /etc/pipewire-volume-mixer
    
    # Install the default config if it doesn't exist
    if [ ! -f /etc/pipewire-volume-mixer/config.toml ]; then
        if [ -f daemon/config.example.toml ]; then
            sudo cp daemon/config.example.toml /etc/pipewire-volume-mixer/config.toml
        else
            # Create a minimal config
            sudo tee /etc/pipewire-volume-mixer/config.toml > /dev/null << 'EOF'
[[virtual_sinks]]
name = "Game"
description = "Virtual sink for game audio"

[[virtual_sinks]]
name = "Media"
description = "Virtual sink for media playback"

[[virtual_sinks]]
name = "Chat"
description = "Virtual sink for voice chat"

[routing]
enable_auto_routing = false
default_sink = "Game"
EOF
        fi
        print_success "Default configuration installed"
    else
        print_info "Configuration already exists, skipping"
    fi
    
    # Install systemd user service
    mkdir -p ~/.config/systemd/user
    cp daemon/pipewire-volume-mixer-daemon.service ~/.config/systemd/user/
    
    # Enable and start the service
    systemctl --user daemon-reload
    systemctl --user enable pipewire-volume-mixer-daemon.service
    systemctl --user start pipewire-volume-mixer-daemon.service
    
    print_success "Daemon service installed and started"
}

# Function to install the GNOME extension
install_extension() {
    print_info "Installing GNOME Shell extension..."
    
    # Check if extension files exist
    if [ ! -f src/extension.js ] || [ ! -f src/metadata.json ]; then
        print_error "Extension source files not found. Are you in the project directory?"
        exit 1
    fi
    
    # Get extension UUID from metadata
    EXTENSION_UUID=$(grep -oP '"uuid":\s*"\K[^"]+' src/metadata.json)
    EXTENSION_DIR="$HOME/.local/share/gnome-shell/extensions/$EXTENSION_UUID"
    
    # Create extension directory
    mkdir -p "$EXTENSION_DIR"
    
    # Copy extension files
    cp src/*.js "$EXTENSION_DIR/"
    cp src/metadata.json "$EXTENSION_DIR/"
    cp src/stylesheet.css "$EXTENSION_DIR/"
    
    print_success "Extension files installed"
    
    # Enable the extension
    gnome-extensions enable "$EXTENSION_UUID"
    print_success "Extension enabled"
}

# Function to create virtual sinks
create_virtual_sinks() {
    print_info "Creating virtual sinks..."
    
    # The daemon should create these automatically, but we can verify
    sleep 2  # Give daemon time to start
    
    if pactl list sinks short | grep -q "Game"; then
        print_success "Virtual sinks created successfully"
    else
        print_warning "Virtual sinks may take a moment to appear"
        print_info "You may need to restart your session or run: systemctl --user restart pipewire-volume-mixer-daemon"
    fi
}

# Main installation flow
main() {
    echo "========================================="
    echo "PipeWire Volume Mixer Installation Script"
    echo "========================================="
    echo
    
    # Check if running as root
    check_sudo
    
    # Detect distribution
    detect_distro
    print_success "Detected distribution: $DISTRO"
    
    # Check GNOME version
    check_gnome_version
    
    # Check and install dependencies
    check_dependencies
    
    # Check for pre-built binary
    check_prebuilt
    
    # Install daemon
    install_daemon
    
    # Install extension
    install_extension
    
    # Create virtual sinks
    create_virtual_sinks
    
    echo
    echo "========================================="
    print_success "Installation completed successfully!"
    echo "========================================="
    echo
    print_info "Next steps:"
    echo "  1. Restart GNOME Shell (Alt+F2, type 'r', press Enter)"
    echo "  2. The extension should appear in your system menu"
    echo "  3. Check the volume menu for the new virtual sinks"
    echo
    print_info "If you encounter issues:"
    echo "  - Check daemon status: systemctl --user status pipewire-volume-mixer-daemon"
    echo "  - View logs: journalctl --user -u pipewire-volume-mixer-daemon -f"
    echo "  - Restart daemon: systemctl --user restart pipewire-volume-mixer-daemon"
    echo
}

# Run main function
main "$@"