# Migration Plan: Current Extension to Service-Based Architecture

## Current State Analysis

### Performance Issues
- Extension spawns `pw-mon` subprocess 
- Multiple `pactl`/`wpctl` calls per UI update
- Parsing overhead for command outputs
- Updates happen even when menu is closed
- ~100-200ms latency for operations

### Code to Remove
- All `Gio.Subprocess` calls
- Command output parsing functions
- pw-mon process management
- Polling/timer-based updates
- Direct PipeWire interaction

## Migration Phases

### Phase 1: Daemon MVP (Week 1)
1. **Basic Daemon**
   - Rust project setup
   - PipeWire connection
   - Event monitoring
   - Simple logging

2. **Core Cache**
   - In-memory state
   - Sink tracking
   - App tracking
   - Basic routing

3. **Testing**
   - Unit tests
   - Integration with real PipeWire
   - Performance baseline

### Phase 2: IPC Implementation (Week 2)
1. **Shared Memory**
   - Define memory layout
   - Implement writer (daemon)
   - Memory mapping
   - Generation counter

2. **Command Socket**
   - Unix domain socket
   - Command protocol
   - Response handling
   - Error propagation

3. **Extension Reader**
   - Prototype GJS shared memory reader
   - Test data retrieval
   - Performance verification

### Phase 3: Extension Refactor (Week 3)
1. **Remove Subprocess Code**
   - Delete all `Gio.Subprocess` usage
   - Remove parsing functions
   - Clean up event handlers

2. **Add Cache Reader**
   ```javascript
   class CacheReader {
       constructor() {
           this._shm = new SharedMemory('/dev/shm/pipewire-volume-mixer-' + GLib.get_user_id());
           this._socket = new Gio.SocketClient();
       }
       
       readCache() {
           // Read from shared memory
           return this._shm.read();
       }
       
       sendCommand(cmd) {
           // Send via socket
           return this._socket.send(cmd);
       }
   }
   ```

3. **Update UI Logic**
   - Only refresh on menu open
   - Use cached data
   - Remove update timers

### Phase 4: System Integration (Week 4)
1. **Packaging**
   - Build daemon binary
   - Create systemd service
   - Package for distribution

2. **Installation**
   - Install script
   - Service auto-start
   - Extension compatibility

3. **Migration Tools**
   - Config migration
   - User data preservation
   - Rollback capability

## Compatibility Strategy

### Transition Period
1. Feature flag for new architecture
2. Fallback to old subprocess method
3. Gradual rollout to users

### Detection Logic
```javascript
function initializeBackend() {
    if (daemonAvailable()) {
        return new DaemonBackend();
    } else {
        log('Warning: Daemon not available, using legacy subprocess backend');
        return new SubprocessBackend();
    }
}
```

## Testing Plan

### Performance Tests
1. **Before Migration**
   - Measure current latency
   - Profile CPU usage
   - Memory baseline

2. **After Migration**
   - Target: 10x performance improvement
   - < 1ms event processing
   - < 0.1% CPU idle

### Functional Tests
- All existing features work
- Auto-routing reliability
- Volume control accuracy
- Mute functionality

### Stress Tests
- 100+ applications
- Rapid switching
- Service restart handling
- Memory pressure

## Rollout Plan

### Beta Testing
1. Developer testing (1 week)
2. Limited beta (5-10 users, 1 week)
3. Extended beta (50 users, 2 weeks)
4. General availability

### Success Metrics
- Zero regression in functionality
- 90% reduction in CPU usage
- 95% reduction in latency
- No memory leaks over 7 days

## Risk Mitigation

### Risks
1. **Daemon Crashes**: Implement auto-restart, fallback mode
2. **Memory Corruption**: Use safe Rust, extensive testing
3. **IPC Failures**: Timeout handling, reconnection logic
4. **Compatibility**: Support multiple GNOME versions

### Rollback Plan
1. Keep old code in separate branch
2. Feature flag for quick disable
3. Clear downgrade instructions
4. Automated rollback on critical errors

## Documentation Updates

1. Update README with new architecture
2. Installation guide for daemon
3. Troubleshooting guide
4. Performance tuning guide

## Future Enhancements

Once stable:
1. D-Bus API for other apps
2. Advanced routing rules
3. Per-app volume memory
4. Integration with WirePlumber
5. Multi-user support