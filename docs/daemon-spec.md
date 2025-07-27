# PipeWire Volume Mixer Daemon Specification

## Performance Requirements

- Event processing latency: < 1ms
- Memory usage: < 10MB
- CPU usage: < 0.1% idle, < 1% under load
- Startup time: < 100ms

## Technology Choice

**Recommended: Rust**
- Zero-cost abstractions
- Memory safety without GC
- Excellent PipeWire bindings (pipewire-rs)
- Easy systemd integration

**Alternative: C**
- Maximum performance
- Direct PipeWire API access
- More complex memory management

## Core Components

### 1. PipeWire Event Handler

```rust
// Pseudo-code structure
struct EventHandler {
    cache: Arc<RwLock<AudioCache>>,
    routing_rules: HashMap<String, String>,
}

impl EventHandler {
    fn on_node_added(&self, node: &Node) {
        if !is_audio_stream(node) { return; }
        
        let app_name = extract_app_name(node);
        let target_sink = self.get_target_sink(&app_name);
        
        // Auto-route if needed
        if should_route(node, target_sink) {
            route_to_sink(node.id, target_sink);
        }
        
        // Update cache
        self.cache.write().update_app(app_name, node);
    }
}
```

### 2. Lock-Free Cache Design

```rust
// Use atomic operations for lock-free reads
struct AudioCache {
    generation: AtomicU64,
    sinks: Arc<DashMap<String, SinkInfo>>,
    apps: Arc<DashMap<String, AppInfo>>,
}

// Shared memory layout (fixed size, no pointers)
#[repr(C)]
struct SharedCache {
    version: u32,
    generation: u64,
    sink_count: u32,
    app_count: u32,
    sinks: [SharedSinkInfo; 8],
    apps: [SharedAppInfo; 128],
}
```

### 3. IPC Protocol

**Commands (via Unix socket):**
```
ROUTE <app_name> <sink_name>
SET_VOLUME <sink_name> <0.0-1.0>
MUTE <sink_name> <true|false>
RELOAD_CONFIG
```

**Responses:**
```
OK
ERROR <message>
```

### 4. Shared Memory Layout

```
/dev/shm/pipewire-volume-mixer-<uid>
├── header (64 bytes)
│   ├── version: u32
│   ├── generation: u64
│   ├── last_update: u64
│   └── flags: u32
├── sinks (512 bytes)
│   └── [sink_id, name, volume, muted] x 8
└── apps (16KB)
    └── [app_name, sink_name, active, input_ids] x 128
```

## Performance Optimizations

### 1. Event Batching
- Collect events for 5ms before processing
- Process multiple changes in single pass
- Coalesce duplicate events

### 2. String Interning
- Pre-allocate common app names
- Use numeric IDs internally
- Single string table in shared memory

### 3. Zero-Copy Updates
- Write directly to shared memory
- Use memory barriers for consistency
- Atomic generation counter

### 4. Minimal Allocations
- Pre-allocated buffers
- Object pools for events
- Stack-based temporary data

## Systemd Service

```ini
[Unit]
Description=PipeWire Volume Mixer Daemon
After=pipewire.service
Requires=pipewire.service

[Service]
Type=simple
ExecStart=/usr/local/bin/pipewire-volume-mixer-daemon
Restart=on-failure
RestartSec=5
User=%u
Environment="RUST_LOG=warn"

# Security
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
NoNewPrivileges=true

# Performance
Nice=-10
IOSchedulingClass=realtime
IOSchedulingPriority=7

[Install]
WantedBy=default.target
```

## Monitoring & Debugging

### Performance Metrics (optional)
- Event processing histogram
- Cache hit/miss rates
- Memory usage over time
- Published via `/run/user/<uid>/pipewire-volume-mixer/stats`

### Debug Mode
- Verbose logging to journal
- Event trace buffer
- Performance profiling hooks

## Build Optimizations

```toml
# Cargo.toml
[profile.release]
lto = true
codegen-units = 1
opt-level = 3
debug = false
strip = true
```

## Testing Strategy

1. **Stress Testing**
   - 1000 events/second
   - 100 simultaneous apps
   - Rapid sink switching

2. **Latency Testing**
   - Measure event-to-cache time
   - Verify < 1ms p99

3. **Memory Testing**
   - Valgrind for leaks
   - Memory usage under load
   - Cache eviction testing