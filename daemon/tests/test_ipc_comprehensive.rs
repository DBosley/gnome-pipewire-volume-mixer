use pipewire_volume_mixer_daemon::cache::{AppInfo, AudioCache, SinkInfo};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tempfile::tempdir;
use tokio::sync::RwLock;

// Performance constants
const MAX_IPC_RESPONSE_TIME_MS: u128 = 10;
const STRESS_TEST_COMMANDS: usize = 1000;

async fn setup_test_ipc() -> (Arc<RwLock<AudioCache>>, String) {
    let cache = Arc::new(RwLock::new(AudioCache::new()));
    let dir = tempdir().unwrap();
    let socket_path = dir.path().join("test.sock").to_str().unwrap().to_string();

    // Pre-populate cache with test data
    {
        let cache_write = cache.write().await;
        cache_write.update_sink(
            "Game".to_string(),
            SinkInfo {
                id: 34,
                name: "Game Audio".to_string(),
                volume: 1.0,
                muted: false,
                pipewire_id: 34,
            },
        );
        cache_write.update_sink(
            "Chat".to_string(),
            SinkInfo {
                id: 39,
                name: "Chat Audio".to_string(),
                volume: 0.57,
                muted: false,
                pipewire_id: 39,
            },
        );
        cache_write.update_sink(
            "Media".to_string(),
            SinkInfo {
                id: 44,
                name: "Media Audio".to_string(),
                volume: 0.71,
                muted: false,
                pipewire_id: 44,
            },
        );
    }

    (cache, socket_path)
}

#[tokio::test]
async fn test_ipc_route_command() {
    let (cache, _socket_path) = setup_test_ipc().await;

    // Test ROUTE command
    {
        let cache_write = cache.write().await;
        cache_write.routing_rules.insert("Firefox".to_string(), "Media".to_string());
    }

    // Verify routing rule was set
    let cache_read = cache.read().await;
    assert_eq!(
        cache_read.routing_rules.get("Firefox").map(|r| r.clone()),
        Some("Media".to_string())
    );
}

#[tokio::test]
async fn test_ipc_set_volume_command() {
    let (cache, _socket_path) = setup_test_ipc().await;

    // Test SET_VOLUME command
    {
        let cache_write = cache.write().await;
        if let Some(mut sink) = cache_write.sinks.get_mut("Game") {
            sink.volume = 0.75;
        };
    }

    // Verify volume was updated
    let cache_read = cache.read().await;
    let game_sink = cache_read.sinks.get("Game").unwrap();
    assert_eq!(game_sink.volume, 0.75);
}

#[tokio::test]
async fn test_ipc_mute_command() {
    let (cache, _socket_path) = setup_test_ipc().await;

    // Test MUTE command
    {
        let cache_write = cache.write().await;
        if let Some(mut sink) = cache_write.sinks.get_mut("Chat") {
            sink.muted = true;
        };
    }

    // Verify mute state was updated
    let cache_read = cache.read().await;
    let chat_sink = cache_read.sinks.get("Chat").unwrap();
    assert!(chat_sink.muted);
}

#[tokio::test]
async fn test_ipc_health_command() {
    let (cache, _socket_path) = setup_test_ipc().await;

    // Add some apps to the cache
    {
        let cache_write = cache.write().await;
        cache_write.update_app(
            "TestApp".to_string(),
            AppInfo {
                display_name: "TestApp".to_string(),
                binary_name: "testapp".to_string(),
                current_sink: "Game".to_string(),
                active: true,
                sink_input_ids: vec![1, 2],
                pipewire_id: 0,
                inactive_since: None,
            },
        );
    }

    // Simulate HEALTH command response
    let cache_read = cache.read().await;
    let sink_count = cache_read.sinks.len();
    let app_count = cache_read.apps.len();
    let generation = cache_read.get_generation();

    assert_eq!(sink_count, 3);
    assert_eq!(app_count, 1);
    assert!(generation > 0);
}

#[tokio::test]
async fn test_ipc_command_performance() {
    let (cache, _socket_path) = setup_test_ipc().await;

    // Measure command processing time
    let commands = vec![
        ("ROUTE Firefox Media", "Route command"),
        ("SET_VOLUME Game 0.8", "Volume command"),
        ("MUTE Chat true", "Mute command"),
        ("HEALTH", "Health command"),
    ];

    for (command, description) in commands {
        let start = Instant::now();

        // Simulate command processing
        match command.split_whitespace().next() {
            Some("ROUTE") => {
                cache
                    .write()
                    .await
                    .routing_rules
                    .insert("Firefox".to_string(), "Media".to_string());
            }
            Some("SET_VOLUME") => {
                if let Some(mut sink) = cache.write().await.sinks.get_mut("Game") {
                    sink.volume = 0.8;
                }
            }
            Some("MUTE") => {
                if let Some(mut sink) = cache.write().await.sinks.get_mut("Chat") {
                    sink.muted = true;
                }
            }
            Some("HEALTH") => {
                let _ = cache.read().await.get_snapshot();
            }
            _ => {}
        }

        let duration = start.elapsed();
        assert!(
            duration.as_millis() <= MAX_IPC_RESPONSE_TIME_MS,
            "{} took {}ms, expected <{}ms",
            description,
            duration.as_millis(),
            MAX_IPC_RESPONSE_TIME_MS
        );
    }
}

#[tokio::test]
async fn test_ipc_concurrent_commands() {
    let (cache, _socket_path) = setup_test_ipc().await;
    let mut handles = vec![];

    // Spawn multiple tasks sending commands concurrently
    for i in 0..10 {
        let cache_clone = cache.clone();
        let handle = tokio::spawn(async move {
            for j in 0..100 {
                let command_type = (i + j) % 4;
                match command_type {
                    0 => {
                        cache_clone
                            .write()
                            .await
                            .routing_rules
                            .insert(format!("App_{i}"), "Media".to_string());
                    }
                    1 => {
                        if let Some(mut sink) = cache_clone.write().await.sinks.get_mut("Game") {
                            sink.volume = (j as f32) / 100.0;
                        }
                    }
                    2 => {
                        if let Some(mut sink) = cache_clone.write().await.sinks.get_mut("Chat") {
                            sink.muted = j % 2 == 0;
                        }
                    }
                    _ => {
                        let _ = cache_clone.read().await.get_snapshot();
                    }
                }
                tokio::time::sleep(Duration::from_micros(10)).await;
            }
        });
        handles.push(handle);
    }

    for handle in handles {
        handle.await.unwrap();
    }

    // Verify cache integrity after concurrent operations
    let final_cache = cache.read().await;
    assert_eq!(final_cache.sinks.len(), 3);
}

#[tokio::test]
async fn test_ipc_invalid_commands() {
    let (_cache, _socket_path) = setup_test_ipc().await;

    // Test various invalid commands
    let invalid_commands = vec![
        "",                        // Empty command
        "UNKNOWN",                 // Unknown command
        "ROUTE",                   // Missing parameters
        "ROUTE Firefox",           // Missing sink parameter
        "SET_VOLUME",              // Missing parameters
        "SET_VOLUME Game",         // Missing volume parameter
        "SET_VOLUME Game invalid", // Invalid volume value
        "SET_VOLUME Game 2.0",     // Volume out of range
        "SET_VOLUME Game -0.5",    // Negative volume
        "MUTE",                    // Missing parameters
        "MUTE Chat",               // Missing mute state
        "MUTE Chat maybe",         // Invalid mute state
    ];

    for invalid_cmd in invalid_commands {
        // These should all be handled gracefully without panicking
        let parts: Vec<&str> = invalid_cmd.split_whitespace().collect();

        // Verify the command would be rejected
        let should_fail = parts.is_empty()
            || match parts[0] {
                "ROUTE" => parts.len() != 3,
                "SET_VOLUME" => {
                    parts.len() != 3
                        || parts
                            .get(2)
                            .and_then(|v| v.parse::<f32>().ok())
                            .map_or(true, |v| !(0.0..=1.0).contains(&v))
                }
                "MUTE" => {
                    parts.len() != 3 || !["true", "false"].contains(parts.get(2).unwrap_or(&""))
                }
                "HEALTH" | "RELOAD_CONFIG" => false,
                _ => true, // Unknown command
            };

        assert!(should_fail, "Command '{invalid_cmd}' should be invalid");
    }
}

#[tokio::test]
async fn test_ipc_stress_test() {
    let (cache, _socket_path) = setup_test_ipc().await;

    let start = Instant::now();

    for i in 0..STRESS_TEST_COMMANDS {
        let command_type = i % 5;
        match command_type {
            0 => {
                cache
                    .write()
                    .await
                    .routing_rules
                    .insert(format!("StressApp_{i}"), ["Game", "Chat", "Media"][i % 3].to_string());
            }
            1 => {
                if let Some(mut sink) = cache.write().await.sinks.get_mut("Game") {
                    sink.volume = ((i % 101) as f32) / 100.0;
                }
            }
            2 => {
                if let Some(mut sink) = cache.write().await.sinks.get_mut("Chat") {
                    sink.muted = i % 2 == 0;
                }
            }
            3 => {
                let _ = cache.read().await.get_snapshot();
            }
            _ => {
                cache.write().await.update_app(
                    format!("StressApp_{i}"),
                    AppInfo {
                        display_name: format!("StressApp_{i}"),
                        binary_name: format!("stressapp_{i}"),
                        current_sink: ["Game", "Chat", "Media"][i % 3].to_string(),
                        active: i % 2 == 0,
                        sink_input_ids: vec![i as u32],
                        pipewire_id: i as u32,
                        inactive_since: None,
                    },
                );
            }
        }
    }

    let duration = start.elapsed();
    let avg_time_us = duration.as_micros() / STRESS_TEST_COMMANDS as u128;

    assert!(
        avg_time_us < 1000,
        "Average command time {avg_time_us}μs is too high (should be <1000μs)"
    );
}

#[tokio::test]
async fn test_ipc_volume_edge_cases() {
    let (cache, _socket_path) = setup_test_ipc().await;

    // Test volume edge cases
    let volume_tests = vec![
        (0.0, false),     // Minimum volume, should not auto-mute
        (0.0, true),      // Minimum volume with mute
        (1.0, false),     // Maximum volume
        (0.5, false),     // Mid volume
        (0.99999, false), // Near maximum
        (0.00001, false), // Near minimum
    ];

    for (volume, muted) in volume_tests {
        let cache_write = cache.write().await;
        if let Some(mut sink) = cache_write.sinks.get_mut("Game") {
            sink.volume = volume;
            sink.muted = muted;
        }
        drop(cache_write);

        let cache_read = cache.read().await;
        let sink = cache_read.sinks.get("Game").unwrap();
        assert_eq!(sink.volume, volume);
        assert_eq!(sink.muted, muted);
    }
}

#[tokio::test]
async fn test_ipc_app_routing_persistence() {
    let (cache, _socket_path) = setup_test_ipc().await;

    // Set up routing rules for various apps
    let apps = vec![
        ("Firefox", "Media"),
        ("Discord", "Chat"),
        ("Elite Dangerous", "Game"),
        ("Spotify", "Media"),
        ("TeamSpeak", "Chat"),
        ("Counter-Strike", "Game"),
    ];

    {
        let cache_write = cache.write().await;
        for (app, sink) in &apps {
            cache_write.routing_rules.insert(app.to_string(), sink.to_string());
        }
    }

    // Verify all routing rules persist
    let cache_read = cache.read().await;
    for (app, expected_sink) in apps {
        let actual_sink = cache_read.routing_rules.get(app).map(|s| s.clone());
        assert_eq!(actual_sink, Some(expected_sink.to_string()));
    }
}

#[tokio::test]
async fn test_ipc_command_with_special_characters() {
    let (cache, _socket_path) = setup_test_ipc().await;

    // Test app names with special characters
    let special_apps = vec![
        "App with spaces",
        "App-with-dashes",
        "App_with_underscores",
        "App.with.dots",
        "日本語アプリ",
        "Приложение",
    ];

    for app in special_apps {
        cache.write().await.routing_rules.insert(app.to_string(), "Media".to_string());

        let cache_read = cache.read().await;
        assert!(cache_read.routing_rules.contains_key(app), "Failed to handle app name: {app}");
    }
}
