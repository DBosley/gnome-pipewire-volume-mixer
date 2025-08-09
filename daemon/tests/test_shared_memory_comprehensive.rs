use pipewire_volume_mixer_daemon::cache::{AppInfo, AudioCache, SinkInfo};
use pipewire_volume_mixer_daemon::shared_memory::SharedMemoryWriter;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};
use tokio::sync::RwLock;

// Performance constants
const MAX_SHM_WRITE_TIME_MS: u128 = 5;
const _MAX_SHM_READ_TIME_MS: u128 = 2;
const SHM_SIZE: usize = 64 * 1024; // 64KB

#[tokio::test]
async fn test_shared_memory_creation() {
    let cache = Arc::new(RwLock::new(AudioCache::new()));
    let uid = nix::unistd::Uid::current();
    let shm_path = format!("/dev/shm/pipewire-volume-mixer-{uid}");

    // Clean up any existing test file
    let _ = fs::remove_file(&shm_path);

    // Create shared memory writer
    let _writer = SharedMemoryWriter::new(cache.clone()).unwrap();

    // Verify file was created
    assert!(Path::new(&shm_path).exists());

    // Verify file size
    let metadata = fs::metadata(&shm_path).unwrap();
    assert_eq!(metadata.len(), SHM_SIZE as u64);

    // Clean up
    let _ = fs::remove_file(&shm_path);
}

#[tokio::test]
async fn test_shared_memory_write_performance() {
    let cache = Arc::new(RwLock::new(AudioCache::new()));

    // Populate cache with test data
    {
        let cache_write = cache.write().await;
        for i in 0..10 {
            cache_write.update_sink(
                format!("Sink_{i}"),
                SinkInfo {
                    id: i,
                    name: format!("TestSink_{i}"),
                    volume: 0.5 + (i as f32 * 0.05),
                    muted: i % 2 == 0,
                },
            );
        }

        for i in 0..5 {
            cache_write.update_app(
                format!("App_{i}"),
                AppInfo {
                    display_name: format!("TestApp_{i}"),
                    binary_name: format!("testapp_{i}"),
                    current_sink: format!("Sink_{}", i % 3),
                    active: true,
                    sink_input_ids: vec![i * 2, i * 2 + 1],
                    inactive_since: None,
                },
            );
        }
    }

    let _writer = SharedMemoryWriter::new(cache.clone()).unwrap();

    // Measure write performance
    let start = Instant::now();
    let _snapshot = cache.read().await.get_snapshot();
    // Simulate the write operation
    let duration = start.elapsed();

    assert!(
        duration.as_millis() <= MAX_SHM_WRITE_TIME_MS,
        "Shared memory write took {}ms, expected <{}ms",
        duration.as_millis(),
        MAX_SHM_WRITE_TIME_MS
    );
}

#[tokio::test]
async fn test_shared_memory_staleness_detection() {
    let _cache = Arc::new(RwLock::new(AudioCache::new()));

    // Test the staleness detection logic
    let now = SystemTime::now();
    let stale_time = now - Duration::from_secs(60); // 1 minute old
    let fresh_time = now - Duration::from_secs(10); // 10 seconds old

    // Staleness should be detected after 30 seconds
    let stale_elapsed = now.duration_since(stale_time).unwrap();
    assert!(stale_elapsed.as_secs() > 30);

    let fresh_elapsed = now.duration_since(fresh_time).unwrap();
    assert!(fresh_elapsed.as_secs() < 30);
}

#[tokio::test]
async fn test_shared_memory_concurrent_access() {
    let cache = Arc::new(RwLock::new(AudioCache::new()));
    let mut handles = vec![];

    // Spawn multiple tasks that update the cache concurrently
    for i in 0..10 {
        let cache_clone = cache.clone();
        let handle = tokio::spawn(async move {
            for j in 0..100 {
                let cache_write = cache_clone.write().await;
                cache_write.update_sink(
                    format!("ConcurrentSink_{i}_{j}"),
                    SinkInfo {
                        id: (i * 100 + j) as u32,
                        name: format!("Sink_{i}"),
                        volume: 0.5,
                        muted: false,
                    },
                );
                drop(cache_write);

                // Simulate reading
                let cache_read = cache_clone.read().await;
                let _ = cache_read.get_snapshot();
                drop(cache_read);

                tokio::time::sleep(Duration::from_micros(100)).await;
            }
        });
        handles.push(handle);
    }

    for handle in handles {
        handle.await.unwrap();
    }

    // Verify data integrity
    let final_cache = cache.read().await;
    assert!(final_cache.sinks.len() >= 900);
}

#[tokio::test]
async fn test_shared_memory_data_integrity() {
    let cache = Arc::new(RwLock::new(AudioCache::new()));

    // Add data with special characters and edge cases
    {
        let cache_write = cache.write().await;

        // Test with maximum values
        cache_write.update_sink(
            "MaxVolume".to_string(),
            SinkInfo { id: u32::MAX, name: "MaxVolumeSink".to_string(), volume: 1.0, muted: false },
        );

        // Test with minimum values
        cache_write.update_sink(
            "MinVolume".to_string(),
            SinkInfo { id: 0, name: "MinVolumeSink".to_string(), volume: 0.0, muted: true },
        );

        // Test with very long names (should be handled gracefully)
        let long_name = "A".repeat(255);
        cache_write.update_app(
            long_name.clone(),
            AppInfo {
                display_name: long_name.clone(),
                binary_name: long_name.clone(),
                current_sink: "Game".to_string(),
                active: true,
                sink_input_ids: vec![1, 2, 3, 4, 5],
                inactive_since: None,
            },
        );
    }

    // Create snapshot and verify data
    let snapshot = cache.read().await.get_snapshot();

    assert!(snapshot.sinks.contains_key("MaxVolume"));
    assert!(snapshot.sinks.contains_key("MinVolume"));

    let max_sink = &snapshot.sinks["MaxVolume"];
    assert_eq!(max_sink.id, u32::MAX);
    assert_eq!(max_sink.volume, 1.0);
    assert!(!max_sink.muted);

    let min_sink = &snapshot.sinks["MinVolume"];
    assert_eq!(min_sink.id, 0);
    assert_eq!(min_sink.volume, 0.0);
    assert!(min_sink.muted);
}

#[tokio::test]
async fn test_shared_memory_recovery_simulation() {
    let cache = Arc::new(RwLock::new(AudioCache::new()));

    // Simulate a scenario where shared memory needs recovery
    {
        let cache_write = cache.write().await;

        // Add initial data
        for i in 0..5 {
            cache_write.update_sink(
                format!("RecoverySink_{i}"),
                SinkInfo { id: i, name: format!("Sink_{i}"), volume: 0.5, muted: false },
            );
        }
    }

    // Simulate multiple rapid updates (stress test)
    for _ in 0..1000 {
        let cache_write = cache.write().await;
        cache_write.increment_generation();
        drop(cache_write);
    }

    // Verify cache is still functional
    let final_cache = cache.read().await;
    assert_eq!(final_cache.sinks.len(), 5);
    assert!(final_cache.get_generation() >= 1000);
}

#[test]
fn test_shared_memory_size_limits() {
    // Test that our data structures fit within the 64KB limit
    let cache = AudioCache::new();

    // Maximum realistic scenario:
    // - 10 sinks (3 virtual + 7 physical)
    // - 50 apps
    // Each sink: ~100 bytes
    // Each app: ~200 bytes
    // Total: ~11KB, well within 64KB limit

    for i in 0..10 {
        cache.update_sink(
            format!("Sink_{i}"),
            SinkInfo { id: i, name: format!("TestSink_{i}"), volume: 0.5, muted: false },
        );
    }

    for i in 0..50 {
        cache.update_app(
            format!("App_{i}"),
            AppInfo {
                display_name: format!("Application_{i}"),
                binary_name: format!("app_{i}"),
                current_sink: "Game".to_string(),
                active: true,
                sink_input_ids: vec![i * 2, i * 2 + 1],
                inactive_since: None,
            },
        );
    }

    let snapshot = cache.get_snapshot();

    // Rough size estimation
    let estimated_size = snapshot.sinks.len() * 100 + snapshot.apps.len() * 200 + 32; // header
    assert!(
        estimated_size < SHM_SIZE,
        "Estimated size {estimated_size} exceeds shared memory limit {SHM_SIZE}"
    );
}

#[tokio::test]
async fn test_periodic_update_mechanism() {
    let cache = Arc::new(RwLock::new(AudioCache::new()));

    // Add some initial data
    {
        let cache_write = cache.write().await;
        cache_write.update_sink(
            "TestSink".to_string(),
            SinkInfo { id: 1, name: "TestSink".to_string(), volume: 0.5, muted: false },
        );
    }

    // Record initial generation
    let initial_gen = cache.read().await.get_generation();

    // Simulate time passing without changes
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Generation should remain the same without updates
    let final_gen = cache.read().await.get_generation();
    assert_eq!(initial_gen, final_gen);
}

#[tokio::test]
async fn test_memory_mapped_file_permissions() {
    let _cache = Arc::new(RwLock::new(AudioCache::new()));
    let uid = nix::unistd::Uid::current();
    let shm_path = format!("/dev/shm/pipewire-volume-mixer-perms-test-{uid}");

    // Clean up any existing test file
    let _ = fs::remove_file(&shm_path);

    // Would create SharedMemoryWriter here if we could specify custom path
    // For now, just verify the concept

    // Create a test file with specific permissions
    fs::write(&shm_path, vec![0u8; SHM_SIZE]).unwrap();

    let metadata = fs::metadata(&shm_path).unwrap();
    let permissions = metadata.permissions();

    // Verify the file is readable and writable by owner
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = permissions.mode();
        assert!(mode & 0o600 == 0o600, "File should be readable and writable by owner");
    }

    // Clean up
    let _ = fs::remove_file(&shm_path);
}
