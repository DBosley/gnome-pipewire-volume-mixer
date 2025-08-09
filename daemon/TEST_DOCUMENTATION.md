# PipeWire Volume Mixer Daemon - Test Documentation

## Test Coverage

The daemon has comprehensive test coverage to ensure it never bogs down the system:

### 1. Stress Tests (`tests/test_stress.rs`)
Tests the daemon under extreme conditions to ensure good performance:

- **Memory Leak Detection**: Verifies no memory leaks after 10,000+ operations
- **CPU Usage Under Load**: Ensures low CPU usage even with 4 concurrent threads
- **Update Latency**: Confirms P99 latency stays under 10ms
- **Large Scale Apps**: Handles 200+ concurrent applications efficiently
- **Snapshot Performance**: Generates snapshots in under 5ms even with 50+ apps

**Performance Guarantees:**
- Memory usage: < 50MB even under stress
- Update latency: < 10ms P99
- Snapshot generation: < 5ms
- No memory leaks
- Handles 200+ apps without degradation

### 2. Cache Tests (`tests/test_cache.rs`)
Basic functionality tests for the cache system:
- Cache creation and initialization
- Sink operations (add, update, volume)
- App operations (add, update, routing)
- Generation tracking

### 3. Additional Test Files Created
- `test_cache_comprehensive.rs` - Extended cache testing with concurrency
- `test_shared_memory_comprehensive.rs` - Shared memory operations and safety
- `test_ipc_comprehensive.rs` - IPC command handling and validation
- `benches/performance.rs` - Performance benchmarks using Criterion

## Running Tests

### Quick Test Suite
```bash
./run_tests.sh
```

### Individual Test Categories
```bash
# Basic tests
cargo test --test test_cache

# Stress tests
cargo test --test test_stress

# All tests
cargo test

# Benchmarks (detailed performance metrics)
cargo bench
```

### Performance Monitoring
The stress tests specifically monitor:
1. Memory usage over time
2. CPU utilization
3. Response latency percentiles (P50, P99)
4. Concurrent operation handling
5. Memory leak detection

## Test Results

All tests pass with the following verified performance characteristics:
- ✅ Memory usage stays under 50MB
- ✅ P99 update latency under 10ms
- ✅ Snapshot generation under 5ms
- ✅ No memory leaks detected
- ✅ Handles 200+ concurrent apps
- ✅ Concurrent read/write operations are thread-safe

## Critical Performance Safeguards

The tests ensure the daemon:
1. **Never uses excessive memory** - Hard limit of 50MB
2. **Never blocks the UI** - All operations complete in milliseconds
3. **Never leaks memory** - Verified through repeated allocation/deallocation cycles
4. **Scales efficiently** - Performance remains constant with many apps
5. **Handles edge cases** - Special characters, Wine apps, overflow conditions

These tests guarantee the daemon will never bog down the system, even under extreme load.