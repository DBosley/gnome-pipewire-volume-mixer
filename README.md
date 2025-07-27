# GNOME PipeWire Volume Mixer

A GNOME Shell extension that adds virtual audio sink controls to the system volume menu, allowing you to route and control audio for different applications separately (similar to Windows audio mixer functionality).

## Features

- Adds Game, Chat, and Media volume sliders to the GNOME volume menu
- Control volume independently for each virtual sink
- Route applications to different sinks with a simple GUI
- High-performance daemon with native PipeWire integration
- Zero-latency UI updates using shared memory
- Works with PipeWire's loopback modules to maintain audio routing

## Requirements

- GNOME Shell 42+ (tested on Pop!_OS 22.04)
- PipeWire audio system
- Rust toolchain (for building the daemon)
- PipeWire loopback module configuration (see Installation)

## Installation

### 1. Install the Daemon

The extension requires a high-performance daemon for PipeWire integration:

```bash
# Build and install the daemon
make daemon-install

# Start the daemon
make daemon-start

# Check daemon status
make daemon-status
```

### 2. Install the Extension

```bash
# Install the extension
make install

# Enable and restart GNOME Shell
make enable restart
```

### 2. Configure PipeWire Virtual Sinks

Create the virtual sinks configuration:

```bash
mkdir -p ~/.config/pipewire/pipewire.conf.d/
```

Create `~/.config/pipewire/pipewire.conf.d/10-virtual-sinks.conf`:

```
context.objects = [
    {
        factory = adapter
        args = {
            factory.name = support.null-audio-sink
            media.class = Audio/Sink
            node.name = "Game"
            node.description = "Game Audio"
            audio.position = [ FL FR ]
            adapter.auto-port-config = {
                mode = dsp
                monitor = true
                position = preserve
            }
        }
    }
    {
        factory = adapter
        args = {
            factory.name = support.null-audio-sink
            media.class = Audio/Sink
            node.name = "Chat"
            node.description = "Chat Audio"
            audio.position = [ FL FR ]
            adapter.auto-port-config = {
                mode = dsp
                monitor = true
                position = preserve
            }
        }
    }
    {
        factory = adapter
        args = {
            factory.name = support.null-audio-sink
            media.class = Audio/Sink
            node.name = "Media"
            node.description = "Media Audio"
            audio.position = [ FL FR ]
            adapter.auto-port-config = {
                mode = dsp
                monitor = true
                position = preserve
            }
        }
    }
]
```

### 3. Configure PipeWire Loopback Modules

Create `~/.config/pipewire/pipewire.conf.d/20-audio-mixing.conf`:

```
context.modules = [
    {
        name = libpipewire-module-loopback
        args = {
            node.description = "Game Audio Loopback"
            capture.props = {
                node.name = "Game_Loopback"
                node.target = "Game"
                stream.capture.sink = true
            }
            playback.props = {
                node.name = "Game_to_Speaker"
            }
        }
    }
    {
        name = libpipewire-module-loopback
        args = {
            node.description = "Chat Audio Loopback"
            capture.props = {
                node.name = "Chat_Loopback"
                node.target = "Chat"
                stream.capture.sink = true
            }
            playback.props = {
                node.name = "Chat_to_Speaker"
            }
        }
    }
    {
        name = libpipewire-module-loopback
        args = {
            node.description = "Media Audio Loopback"
            capture.props = {
                node.name = "Media_Loopback"
                node.target = "Media"
                stream.capture.sink = true
            }
            playback.props = {
                node.name = "Media_to_Speaker"
            }
        }
    }
]
```

### 4. Restart PipeWire

```bash
systemctl --user restart pipewire pipewire-pulse
```

### 5. Install the Mixer Control Script (Optional)

Create `~/.local/bin/mixer-control`:

```bash
#!/bin/bash
# Control mixer volumes and route applications

case "$1" in
    route)
        # Route an app to a specific sink
        # Usage: mixer-control route <app-name> <game|chat|media>
        APP="$2"
        SINK="$3"
        
        case "$SINK" in
            game) TARGET="Game" ;;
            chat) TARGET="Chat" ;;
            media) TARGET="Media" ;;
            *) echo "Invalid sink: $SINK"; exit 1 ;;
        esac
        
        # Find the app's stream and move it
        pactl list sink-inputs | grep -B20 -i "$APP" | grep "Sink Input" | cut -d'#' -f2 | while read id; do
            pactl move-sink-input "$id" "$TARGET"
            echo "Moved $APP to $TARGET"
        done
        ;;
    *)
        echo "Usage: mixer-control route <app-name> {game|chat|media}"
        ;;
esac
```

Make it executable:
```bash
chmod +x ~/.local/bin/mixer-control
```

## Usage

1. Click on the volume icon in the system tray
2. You'll see three new sliders: Game, Chat, and Media
3. Route applications to different sinks:
   ```bash
   mixer-control route firefox media
   mixer-control route discord chat
   mixer-control route steam game
   ```
4. Adjust the volume for each sink independently

## How It Works

The extension creates virtual PipeWire sinks that applications can output to. Loopback modules then route audio from these virtual sinks to your actual audio output. The extension controls both the virtual sink volumes and the loopback stream volumes to ensure the volume sliders work correctly.

## Troubleshooting

- If you don't hear audio after routing an app, try refreshing/restarting the application
- If PipeWire crashes, check the loopback configuration syntax
- The sliders control the loopback stream volumes, not the virtual sink volumes directly

## License

GPL-3.0 (same as GNOME Shell)

## Author

Created by Dave with assistance from Claude