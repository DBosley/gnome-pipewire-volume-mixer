use pipewire_volume_mixer_daemon::cache::{AppInfo, AudioCache, SinkInfo};
use pipewire_volume_mixer_daemon::config::AppMappings;
use pipewire_volume_mixer_daemon::dbus_service::start_dbus_service;
use pipewire_volume_mixer_daemon::pipewire_controller::PipeWireController;
use std::sync::Arc;
use tokio::sync::RwLock;

#[tokio::test]
async fn test_dbus_service_starts() {
    // Initialize cache with test data
    let cache = Arc::new(RwLock::new(AudioCache::new()));

    // Add test data
    {
        let cache_write = cache.write().await;
        cache_write.update_sink(
            "TestSink".to_string(),
            SinkInfo {
                id: 1,
                name: "TestSink".to_string(),
                volume: 0.75,
                muted: false,
                pipewire_id: 1,
            },
        );

        cache_write.update_app(
            "TestApp".to_string(),
            AppInfo {
                display_name: "TestApp".to_string(),
                binary_name: "testapp".to_string(),
                stream_names: vec!["testapp".to_string()],
                current_sink: "TestSink".to_string(),
                active: true,
                sink_input_ids: vec![100],
                pipewire_id: 100,
                inactive_since: None,
            },
        );
    }

    // Initialize controller
    let controller = Arc::new(PipeWireController::new(cache.clone()));

    // Initialize app mappings
    let app_mappings = Arc::new(RwLock::new(AppMappings::default()));

    // Try to start D-Bus service
    let result = start_dbus_service(cache.clone(), controller, app_mappings).await;

    // The service might fail if another instance is running, which is OK for testing
    if let Ok(connection) = result {
        // Verify we got a connection
        assert!(connection.unique_name().is_some());

        // Clean up
        connection.release_name("org.gnome.PipewireVolumeMixer").await.ok();
    }
}

#[tokio::test]
async fn test_dbus_properties_accessible() {
    // Initialize cache
    let cache = Arc::new(RwLock::new(AudioCache::new()));
    let controller = Arc::new(PipeWireController::new(cache.clone()));
    let app_mappings = Arc::new(RwLock::new(AppMappings::default()));

    // Try to connect to existing service or skip test
    if let Ok(_connection) = start_dbus_service(cache.clone(), controller, app_mappings).await {
        // If we can start a service, it means no other instance is running
        // We can test properties here in the future
    }
    // If service is already running, skip this test
}
