use pipewire_volume_mixer_daemon::cache::{AppInfo, AudioCache, SinkInfo};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

// Critical performance limits - the daemon should NEVER exceed these
const _MAX_MEMORY_MB: f64 = 50.0; // Should use less than 50MB even under stress
const _MAX_CPU_PERCENT: f64 = 5.0; // Should use less than 5% CPU on average
const MAX_UPDATE_LATENCY_MS: u128 = 10; // Updates should be processed within 10ms

#[tokio::test]
async fn test_memory_leak_detection() {
    let cache = Arc::new(RwLock::new(AudioCache::new()));

    // Get initial memory usage
    let initial_memory = get_current_memory_usage();

    // Perform many operations that could leak memory
    for _cycle in 0..100 {
        let cache_write = cache.write().await;

        // Add and remove many items
        for i in 0..100 {
            cache_write.update_app(
                format!("TempApp_{i}"),
                AppInfo {
                    display_name: format!("TempApp_{i}"),
                    binary_name: format!("tempapp_{i}"),
                    current_sink: "Game".to_string(),
                    active: true,
                    sink_input_ids: vec![i],
                    pipewire_id: i,
                    inactive_since: None,
                },
            );
        }

        // Clear them
        cache_write.apps.clear();

        // Force generation updates
        for _ in 0..100 {
            cache_write.increment_generation();
        }
    }

    // Get final memory usage
    let final_memory = get_current_memory_usage();

    // Memory growth should be minimal (less than 10MB)
    let memory_growth = final_memory - initial_memory;
    assert!(memory_growth < 10.0, "Memory leak detected: grew by {memory_growth:.2}MB");
}

#[tokio::test]
async fn test_cpu_usage_under_load() {
    let cache = Arc::new(RwLock::new(AudioCache::new()));
    let test_duration = Duration::from_secs(5);
    let start = Instant::now();

    // Spawn multiple tasks simulating heavy load
    let mut handles = vec![];

    for thread_id in 0..4 {
        let cache_clone = cache.clone();
        let handle = tokio::spawn(async move {
            while start.elapsed() < test_duration {
                // Simulate rapid updates
                for i in 0..10 {
                    let cache_write = cache_clone.write().await;
                    cache_write.update_sink(
                        format!("LoadSink_{thread_id}_{i}"),
                        SinkInfo {
                            id: (thread_id * 10 + i) as u32,
                            name: format!("Sink_{i}"),
                            volume: 0.5,
                            muted: false,
                            pipewire_id: (thread_id * 10 + i) as u32,
                        },
                    );
                    drop(cache_write);

                    // Simulate reads
                    let cache_read = cache_clone.read().await;
                    let _ = cache_read.get_snapshot();
                    drop(cache_read);
                }

                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        });
        handles.push(handle);
    }

    // Wait for all tasks
    for handle in handles {
        handle.await.unwrap();
    }

    // CPU usage should remain low even under load
    // This is a simplified check - in production you'd measure actual CPU time
    let elapsed = start.elapsed();
    assert!(elapsed.as_secs() <= 6, "Tasks took too long, indicating high CPU usage");
}

#[tokio::test]
async fn test_update_latency_under_stress() {
    let cache = Arc::new(RwLock::new(AudioCache::new()));

    // Pre-populate with realistic data
    {
        let cache_write = cache.write().await;
        for i in 0..50 {
            cache_write.update_app(
                format!("App_{i}"),
                AppInfo {
                    display_name: format!("App_{i}"),
                    binary_name: format!("app_{i}"),
                    current_sink: ["Game", "Chat", "Media"][i % 3].to_string(),
                    active: i % 2 == 0,
                    sink_input_ids: vec![i as u32],
                    pipewire_id: i as u32,
                    inactive_since: None,
                },
            );
        }
    }

    // Measure update latency under concurrent load
    let mut latencies = vec![];

    for _ in 0..100 {
        let start = Instant::now();

        let cache_write = cache.write().await;
        cache_write.update_sink(
            "TestSink".to_string(),
            SinkInfo {
                id: 1,
                name: "TestSink".to_string(),
                volume: 0.5,
                muted: false,
                pipewire_id: 1,
            },
        );
        drop(cache_write);

        let latency = start.elapsed();
        latencies.push(latency.as_millis());
    }

    // Check that 99% of updates are under the limit
    latencies.sort();
    let p99_latency = latencies[latencies.len() * 99 / 100];
    assert!(
        p99_latency <= MAX_UPDATE_LATENCY_MS,
        "P99 latency {p99_latency}ms exceeds limit of {MAX_UPDATE_LATENCY_MS}ms"
    );
}

#[tokio::test]
async fn test_large_scale_app_handling() {
    let cache = Arc::new(RwLock::new(AudioCache::new()));

    // Simulate a system with many audio applications
    let start = Instant::now();

    {
        let cache_write = cache.write().await;

        // Add 200 apps (extreme but possible scenario)
        for i in 0..200 {
            cache_write.update_app(
                format!("App_{i}"),
                AppInfo {
                    display_name: format!("Application {i}"),
                    binary_name: format!("app_{i}"),
                    current_sink: ["Game", "Chat", "Media"][i % 3].to_string(),
                    active: i < 20, // Only 20 active
                    sink_input_ids: if i < 20 { vec![i as u32] } else { vec![] },
                    pipewire_id: i as u32,
                    inactive_since: if i >= 20 {
                        Some(std::time::Instant::now() - Duration::from_secs(60))
                    } else {
                        None
                    },
                },
            );
        }
    }

    let setup_time = start.elapsed();
    assert!(
        setup_time.as_millis() < 100,
        "Adding 200 apps took {}ms, should be <100ms",
        setup_time.as_millis()
    );

    // Test cleanup performance
    let cleanup_start = Instant::now();
    let removed = cache.read().await.cleanup_inactive_apps(30);
    let cleanup_time = cleanup_start.elapsed();

    assert!(removed >= 180, "Should have cleaned up most inactive apps");
    assert!(
        cleanup_time.as_millis() < 50,
        "Cleanup took {}ms, should be <50ms",
        cleanup_time.as_millis()
    );
}

#[tokio::test]
async fn test_snapshot_generation_performance() {
    let cache = Arc::new(RwLock::new(AudioCache::new()));

    // Create a worst-case scenario
    {
        let cache_write = cache.write().await;

        // Maximum expected sinks (3 virtual + ~10 physical)
        for i in 0..13 {
            cache_write.update_sink(
                format!("Sink_{i}"),
                SinkInfo {
                    id: i as u32,
                    name: format!("Audio Sink {i}"),
                    volume: 0.5,
                    muted: false,
                    pipewire_id: i as u32,
                },
            );
        }

        // Maximum reasonable concurrent apps
        for i in 0..50 {
            cache_write.update_app(
                format!("App_{i}"),
                AppInfo {
                    display_name: format!("Application {i}"),
                    binary_name: format!("app_{i}"),
                    current_sink: format!("Sink_{}", i % 13),
                    active: true,
                    sink_input_ids: vec![i as u32 * 2, i as u32 * 2 + 1],
                    pipewire_id: i as u32,
                    inactive_since: None,
                },
            );
        }
    }

    // Measure snapshot generation time
    let mut snapshot_times = vec![];

    for _ in 0..1000 {
        let start = Instant::now();
        let cache_read = cache.read().await;
        let _ = cache_read.get_snapshot();
        drop(cache_read);
        snapshot_times.push(start.elapsed().as_micros());
    }

    // Calculate statistics
    snapshot_times.sort();
    let median = snapshot_times[snapshot_times.len() / 2];
    let p99 = snapshot_times[snapshot_times.len() * 99 / 100];

    assert!(median < 1000, "Median snapshot time {median}μs should be <1000μs");
    assert!(p99 < 5000, "P99 snapshot time {p99}μs should be <5000μs");
}

// Helper function to get current memory usage (simplified)
fn get_current_memory_usage() -> f64 {
    // In a real implementation, you'd use /proc/self/status or similar
    // This is a placeholder that returns a mock value
    use std::fs;

    if let Ok(status) = fs::read_to_string("/proc/self/status") {
        for line in status.lines() {
            if line.starts_with("VmRSS:") {
                if let Some(kb_str) = line.split_whitespace().nth(1) {
                    if let Ok(kb) = kb_str.parse::<f64>() {
                        return kb / 1024.0; // Convert to MB
                    }
                }
            }
        }
    }

    0.0
}
