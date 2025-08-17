use pipewire_volume_mixer_daemon::cache::{AppInfo, AudioCache, SinkInfo};

#[test]
fn test_cache_creation() {
    let cache = AudioCache::new();
    assert_eq!(cache.get_generation(), 0);
}

#[test]
fn test_sink_operations() {
    let cache = AudioCache::new();

    let sink = SinkInfo {
        id: 42,
        name: "Test Sink".to_string(),
        volume: 0.75,
        muted: false,
        pipewire_id: 42,
    };

    cache.update_sink("Test Sink".to_string(), sink.clone());

    let sinks = cache.sinks.clone();
    assert_eq!(sinks.len(), 1);
    assert_eq!(sinks.get("Test Sink").unwrap().volume, 0.75);
}

#[test]
fn test_app_operations() {
    let cache = AudioCache::new();

    let app = AppInfo {
        display_name: "Firefox".to_string(),
        binary_name: "firefox".to_string(),
        current_sink: "Media".to_string(),
        active: true,
        sink_input_ids: vec![123, 456],
        pipewire_id: 100,
        inactive_since: None,
    };

    cache.update_app("Firefox".to_string(), app.clone());

    let apps = cache.apps.clone();
    assert_eq!(apps.len(), 1);
    assert_eq!(apps.get("Firefox").unwrap().current_sink, "Media");
}

#[test]
fn test_generation_increment() {
    let cache = AudioCache::new();
    let gen1 = cache.get_generation();

    cache.update_sink(
        "Test".to_string(),
        SinkInfo { id: 1, name: "Test".to_string(), volume: 1.0, muted: false, pipewire_id: 1 },
    );

    let gen2 = cache.get_generation();
    assert!(gen2 > gen1);
}
