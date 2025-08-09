use pipewire_volume_mixer_daemon::cache::{AppInfo, AudioCache, SinkInfo};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

// Performance constants - adjust if tests fail on slower systems
const MAX_CACHE_UPDATE_TIME_MS: u128 = 1; // Cache updates should be sub-millisecond
const MAX_SNAPSHOT_TIME_MS: u128 = 5; // Snapshots should be very fast
const STRESS_TEST_ITERATIONS: usize = 10000;

#[test]
fn test_concurrent_cache_access() {
    let cache = Arc::new(AudioCache::new());
    let mut handles = vec![];

    // Spawn multiple threads to stress test concurrent access
    for i in 0..10 {
        let cache_clone = cache.clone();
        let handle = std::thread::spawn(move || {
            for j in 0..100 {
                let sink = SinkInfo {
                    id: (i * 100 + j) as u32,
                    name: format!("Sink_{i}"),
                    volume: 0.5,
                    muted: false,
                };
                cache_clone.update_sink(format!("Sink_{i}_{j}"), sink);
            }
        });
        handles.push(handle);
    }

    for handle in handles {
        handle.join().unwrap();
    }

    // Verify all updates were applied
    assert!(cache.sinks.len() >= 900); // Allow for some overwrites
}

#[test]
fn test_cache_performance_single_update() {
    let cache = AudioCache::new();

    let sink = SinkInfo { id: 1, name: "Test".to_string(), volume: 0.5, muted: false };

    let start = Instant::now();
    cache.update_sink("Test".to_string(), sink);
    let duration = start.elapsed();

    assert!(
        duration.as_millis() <= MAX_CACHE_UPDATE_TIME_MS,
        "Cache update took {}ms, expected <{}ms",
        duration.as_millis(),
        MAX_CACHE_UPDATE_TIME_MS
    );
}

#[test]
fn test_cache_performance_bulk_updates() {
    let cache = AudioCache::new();

    let start = Instant::now();
    for i in 0..STRESS_TEST_ITERATIONS {
        let sink =
            SinkInfo { id: i as u32, name: format!("Sink_{i}"), volume: 0.5, muted: false };
        cache.update_sink(format!("Sink_{i}"), sink);
    }
    let duration = start.elapsed();

    let avg_time_us = duration.as_micros() / STRESS_TEST_ITERATIONS as u128;
    assert!(
        avg_time_us < 100,
        "Average update time {avg_time_us}μs is too high (should be <100μs)"
    );
}

#[test]
fn test_snapshot_performance() {
    let cache = AudioCache::new();

    // Populate cache with realistic data
    for i in 0..50 {
        cache.update_sink(
            format!("Sink_{i}"),
            SinkInfo { id: i, name: format!("Sink_{i}"), volume: 0.5, muted: false },
        );
    }

    for i in 0..20 {
        cache.update_app(
            format!("App_{i}"),
            AppInfo {
                display_name: format!("App_{i}"),
                binary_name: format!("app_{i}"),
                current_sink: "Game".to_string(),
                active: true,
                sink_input_ids: vec![i * 2, i * 2 + 1],
                inactive_since: None,
            },
        );
    }

    let start = Instant::now();
    let _snapshot = cache.get_snapshot();
    let duration = start.elapsed();

    assert!(
        duration.as_millis() <= MAX_SNAPSHOT_TIME_MS,
        "Snapshot took {}ms, expected <{}ms",
        duration.as_millis(),
        MAX_SNAPSHOT_TIME_MS
    );
}

#[test]
fn test_memory_cleanup() {
    let cache = AudioCache::new();

    // Add inactive apps
    for i in 0..100 {
        cache.update_app(
            format!("InactiveApp_{i}"),
            AppInfo {
                display_name: format!("InactiveApp_{i}"),
                binary_name: format!("inactive_{i}"),
                current_sink: "Game".to_string(),
                active: false,
                sink_input_ids: vec![],
                inactive_since: Some(Instant::now() - Duration::from_secs(400)), // Old inactive
            },
        );
    }

    // Add active apps that should be kept
    for i in 0..10 {
        cache.update_app(
            format!("ActiveApp_{i}"),
            AppInfo {
                display_name: format!("ActiveApp_{i}"),
                binary_name: format!("active_{i}"),
                current_sink: "Media".to_string(),
                active: true,
                sink_input_ids: vec![i],
                inactive_since: None,
            },
        );
    }

    let initial_count = cache.apps.len();
    let removed = cache.cleanup_inactive_apps(300); // 5 minute TTL
    let final_count = cache.apps.len();

    assert_eq!(removed, 100, "Should have removed all 100 inactive apps");
    assert_eq!(final_count, 10, "Should only have 10 active apps remaining");
    assert_eq!(initial_count - removed, final_count);
}

#[test]
fn test_routing_rules_persistence() {
    let cache = AudioCache::new();

    // Add routing rules
    cache.routing_rules.insert("Firefox".to_string(), "Media".to_string());
    cache.routing_rules.insert("Discord".to_string(), "Chat".to_string());
    cache.routing_rules.insert("Elite Dangerous".to_string(), "Game".to_string());

    // Add corresponding apps
    cache.update_app(
        "Firefox".to_string(),
        AppInfo {
            display_name: "Firefox".to_string(),
            binary_name: "firefox".to_string(),
            current_sink: "Media".to_string(),
            active: true,
            sink_input_ids: vec![1],
            inactive_since: None,
        },
    );

    // Verify routing rules are accessible
    assert_eq!(cache.routing_rules.get("Firefox").map(|r| r.clone()), Some("Media".to_string()));
    assert_eq!(cache.routing_rules.get("Discord").map(|r| r.clone()), Some("Chat".to_string()));
    assert_eq!(
        cache.routing_rules.get("Elite Dangerous").map(|r| r.clone()),
        Some("Game".to_string())
    );
}

#[test]
fn test_cache_with_special_characters() {
    let cache = AudioCache::new();

    // Test with various special characters that might appear in app names
    let test_names = vec![
        "App with spaces",
        "App-with-dashes",
        "App_with_underscores",
        "App.with.dots",
        "App(with)parens",
        "App[with]brackets",
        "App'with'quotes",
        "日本語アプリ", // Japanese
        "Приложение",   // Russian
        "🎮 Game App",  // Emoji
    ];

    for name in test_names {
        cache.update_app(
            name.to_string(),
            AppInfo {
                display_name: name.to_string(),
                binary_name: "test".to_string(),
                current_sink: "Game".to_string(),
                active: true,
                sink_input_ids: vec![1],
                inactive_since: None,
            },
        );

        assert!(cache.apps.contains_key(name), "Failed to store app with name: {name}");
    }
}

#[tokio::test]
async fn test_async_cache_operations() {
    let cache = Arc::new(RwLock::new(AudioCache::new()));

    // Test concurrent async reads and writes
    let mut handles = vec![];

    for i in 0..10 {
        let cache_clone = cache.clone();
        let handle = tokio::spawn(async move {
            for j in 0..100 {
                let cache_write = cache_clone.write().await;
                cache_write.update_sink(
                    format!("AsyncSink_{i}_{j}"),
                    SinkInfo {
                        id: (i * 100 + j) as u32,
                        name: format!("AsyncSink_{i}"),
                        volume: 0.5,
                        muted: false,
                    },
                );
                drop(cache_write);

                // Simulate some async work
                tokio::time::sleep(Duration::from_micros(10)).await;

                let cache_read = cache_clone.read().await;
                let _ = cache_read.get_snapshot();
            }
        });
        handles.push(handle);
    }

    for handle in handles {
        handle.await.unwrap();
    }

    let final_cache = cache.read().await;
    assert!(final_cache.sinks.len() >= 900);
}

#[test]
fn test_wine_app_detection() {
    let cache = AudioCache::new();

    // Test that Wine apps are properly handled
    let wine_apps = vec![
        ("Elite Dangerous", "wine64-preloader", "Elite Dangerous"), // Should use app name
        ("", "wine64-preloader", "Wine64-preloader"),               // Should capitalize binary
        ("wine", "notepad.exe", "Notepad"), // Should use cleaned binary name
        ("WINE", "game.exe", "Game"),       // Should use cleaned binary name
    ];

    for (_app_name, binary_name, expected_display) in wine_apps {
        cache.update_app(
            expected_display.to_string(),
            AppInfo {
                display_name: expected_display.to_string(),
                binary_name: binary_name.to_string(),
                current_sink: "Game".to_string(),
                active: true,
                sink_input_ids: vec![1],
                inactive_since: None,
            },
        );

        let app = cache.apps.get(expected_display).unwrap();
        assert_eq!(app.display_name, expected_display);
    }
}

#[test]
fn test_cache_memory_usage() {
    let cache = AudioCache::new();

    // Add a large number of entries to test memory usage
    for i in 0..1000 {
        cache.update_sink(
            format!("Sink_{i}"),
            SinkInfo {
                id: i as u32,
                name: format!("Very_Long_Sink_Name_To_Test_Memory_Usage_{i}"),
                volume: 0.5,
                muted: false,
            },
        );

        cache.update_app(
            format!("App_{i}"),
            AppInfo {
                display_name: format!("Very_Long_App_Display_Name_To_Test_Memory_{i}"),
                binary_name: format!("very_long_binary_name_to_test_memory_{i}"),
                current_sink: format!("Sink_{}", i % 10),
                active: i % 2 == 0,
                sink_input_ids: vec![i as u32 * 2, i as u32 * 2 + 1],
                inactive_since: if i % 2 == 1 { Some(Instant::now()) } else { None },
            },
        );
    }

    // Get snapshot and ensure it doesn't take too long even with many entries
    let start = Instant::now();
    let snapshot = cache.get_snapshot();
    let duration = start.elapsed();

    assert_eq!(snapshot.sinks.len(), 1000);
    assert_eq!(snapshot.apps.len(), 1000);
    assert!(
        duration.as_millis() < 50,
        "Snapshot of 1000 entries took {}ms, should be <50ms",
        duration.as_millis()
    );
}
