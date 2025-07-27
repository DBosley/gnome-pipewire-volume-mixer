# Performance Analysis and Optimization Plan

## Current Performance Issues

Based on the logs we captured, the current extension has significant performance overhead:

1. **Subprocess Spawning**: Each operation spawns multiple processes
   - `pactl list sink-inputs` 
   - `wpctl status`
   - `pactl move-sink-input`

2. **Event Processing**: External events trigger:
   - `monitorNewStreams()`: 49-59ms
   - UI updates: 129ms
   - Total latency: ~180ms per event

3. **Missing PipeWire Events**: The pw-mon process is running but events aren't being captured properly by the extension

## Root Causes

1. **Architecture Mismatch**: GNOME Shell extensions aren't designed for real-time event processing
2. **IPC Overhead**: Each subprocess call involves:
   - Process creation
   - Shell interpretation  
   - Output parsing
   - String manipulation

3. **Synchronous Operations**: Extension blocks on subprocess calls
4. **Unnecessary Updates**: Updates happen even when menu is closed

## Solution: High-Performance Daemon

### Performance Targets
- Event detection: < 1ms (currently 50-100ms)
- Event processing: < 5ms (currently 180ms)
- Memory usage: < 10MB constant
- CPU usage: < 0.1% idle

### How It Works

1. **Direct PipeWire API**: No subprocess overhead
2. **Shared Memory**: Lock-free reads from extension
3. **Event Batching**: Process multiple events together
4. **Lazy UI Updates**: Only when menu is visible

### Expected Improvements

| Metric | Current | Target | Improvement |
|--------|---------|--------|-------------|
| Event Latency | 180ms | 5ms | 36x |
| CPU Usage (idle) | 0.5-1% | <0.1% | 10x |
| Memory | Variable | 10MB constant | Predictable |
| Subprocess Calls | 100s/min | 0 | ∞ |

## Implementation Status

✅ Architecture documented
✅ Daemon structure created
✅ Core components implemented:
  - Cache system
  - Shared memory writer
  - IPC server
  - PipeWire monitor skeleton

🔄 Next steps:
  - Complete PipeWire event handling
  - Implement actual routing/volume control
  - Create GJS shared memory reader
  - Refactor extension to use daemon

## Testing the Current Performance

Run the performance measurement script:
```bash
./scripts/measure-performance.sh
```

This will give you baseline metrics to compare against once the daemon is implemented.