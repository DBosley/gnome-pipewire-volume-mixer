# PipeWire Volume Mixer Architecture

## Overview

The PipeWire Volume Mixer consists of two main components:
1. **High-Performance Monitoring Service** - A systemd service that monitors PipeWire events
2. **GNOME Shell Extension** - UI component that displays cached data

## Design Goals

- **Extreme Performance**: Minimize CPU usage and latency
- **Event-Driven**: React to PipeWire events in real-time
- **Efficient Caching**: Store only necessary data in memory
- **Lazy UI Updates**: Only update UI when menu is visible
- **Zero Subprocess Calls**: Extension never calls pactl/wpctl directly

## Architecture

### 1. PipeWire Monitoring Service (`pipewire-volume-mixer-daemon`)

A lightweight daemon written in a high-performance language (Rust/C/Go) that:

#### Responsibilities:
- Connects directly to PipeWire via native API (not pw-mon subprocess)
- Monitors all audio stream creation/destruction events
- Tracks sink assignments for each application
- Maintains in-memory cache of:
  - Active applications and their sink assignments
  - Virtual sink IDs and metadata
  - Volume levels for each sink
  - Application binary names and display names
  - Historical app assignments (sticky memory)

#### Performance Optimizations:
- Direct PipeWire API integration (no subprocess overhead)
- Event debouncing at source
- Minimal memory allocations
- Lock-free data structures for cache
- Binary protocol for IPC

#### Cache Structure:
```json
{
  "sinks": {
    "Game": { "id": 34, "volume": 0.75, "muted": false },
    "Chat": { "id": 39, "volume": 0.50, "muted": false },
    "Media": { "id": 44, "volume": 1.00, "muted": false }
  },
  "apps": {
    "firefox": {
      "display_name": "Firefox",
      "current_sink": "Media",
      "active": true,
      "sink_input_ids": [3686]
    },
    "discord": {
      "display_name": "Discord", 
      "current_sink": "Chat",
      "active": false,
      "sink_input_ids": []
    }
  },
  "routing_rules": {
    "firefox": "Media",
    "discord": "Chat"
  },
  "last_update": 1737963600000
}
```

### 2. IPC Mechanism

Options (in order of performance):
1. **Shared Memory** - mmap'd file with lock-free reads
2. **Unix Domain Socket** - For bidirectional communication
3. **D-Bus** - Standard but slower

Recommended: **Shared Memory** for reads, **Unix Socket** for commands

### 3. GNOME Shell Extension

#### Responsibilities:
- Read cached data when menu opens
- Display UI based on cached state
- Send routing commands to daemon
- Update UI only when visible

#### Key Changes from Current Implementation:
- Remove all `Gio.Subprocess` calls
- Remove pw-mon process management
- Remove pactl/wpctl parsing
- Read from shared memory cache instead
- Only update when menu is open

#### Performance Optimizations:
- Single cache read on menu open
- No parsing or subprocess overhead
- Minimal GObject allocations
- Debounced UI updates

## Implementation Plan

### Phase 1: Daemon Development
1. Create high-performance daemon in Rust/C/Go
2. Implement PipeWire event monitoring
3. Build efficient cache data structure
4. Set up IPC mechanism

### Phase 2: Extension Refactoring
1. Remove all subprocess calls
2. Implement cache reading
3. Update only on menu visibility
4. Send commands via IPC

### Phase 3: System Integration
1. Create systemd service unit
2. Handle service startup/shutdown
3. Implement health checks
4. Add configuration file support

## Benefits

1. **Performance**: 
   - No subprocess overhead
   - No parsing overhead
   - Minimal CPU usage when menu closed
   - Sub-millisecond event processing

2. **Reliability**:
   - Service can restart without affecting extension
   - Better error handling
   - Consistent state management

3. **Scalability**:
   - Can handle hundreds of audio streams
   - Efficient memory usage
   - Future extensibility

## Configuration

Service configuration via `/etc/pipewire-volume-mixer/config.toml`:
```toml
[cache]
update_interval_ms = 100
max_remembered_apps = 50

[routing]
enable_auto_routing = true
default_sink = "Game"

[performance]
event_debounce_ms = 50
max_events_per_second = 100
```

## Security

- Service runs as user (not root)
- Read-only shared memory for extension
- Validated IPC commands
- No arbitrary command execution