// Test version without PipeWire dependencies
use anyhow::Result;
use nix::unistd::Uid;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use tracing::{debug, info};

#[path = "cache.rs"]
mod cache;
#[path = "ipc.rs"]
mod ipc;

use cache::{AppInfo, AudioCache, SinkInfo};
use ipc::IpcServer;

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize logging
    tracing_subscriber::fmt().with_env_filter("debug").init();

    info!("Starting PipeWire Volume Mixer Daemon (TEST MODE)");

    // Initialize shared cache
    let cache = Arc::new(RwLock::new(AudioCache::new()));

    // Add some test data
    {
        let cache_write = cache.write().await;

        // Add virtual sinks
        cache_write.update_sink(
            "Game".to_string(),
            SinkInfo {
                id: 100,
                name: "Game".to_string(),
                volume: 0.75,
                muted: false,
                pipewire_id: 100,
            },
        );

        cache_write.update_sink(
            "Chat".to_string(),
            SinkInfo {
                id: 101,
                name: "Chat".to_string(),
                volume: 0.5,
                muted: false,
                pipewire_id: 101,
            },
        );

        cache_write.update_sink(
            "Media".to_string(),
            SinkInfo {
                id: 102,
                name: "Media".to_string(),
                volume: 1.0,
                muted: false,
                pipewire_id: 102,
            },
        );

        // Add some test apps
        cache_write.update_app(
            "Firefox".to_string(),
            AppInfo {
                display_name: "Firefox".to_string(),
                binary_name: "firefox".to_string(),
                stream_names: vec!["Firefox".to_string()],
                current_sink: "Media".to_string(),
                active: true,
                sink_input_ids: vec![200],
                pipewire_id: 200,
                inactive_since: None,
            },
        );

        cache_write.update_app(
            "Discord".to_string(),
            AppInfo {
                display_name: "Discord".to_string(),
                binary_name: "discord".to_string(),
                stream_names: vec!["Discord".to_string()],
                current_sink: "Chat".to_string(),
                active: false,
                sink_input_ids: vec![],
                pipewire_id: 201,
                inactive_since: Some(std::time::Instant::now()),
            },
        );
    }

    // Start IPC server
    let ipc_server = IpcServer::new(cache.clone())?;
    let _ipc_handle = tokio::spawn(async move {
        if let Err(e) = ipc_server.run().await {
            tracing::error!("IPC server error: {}", e);
        }
    });

    // Simulate some updates
    let cache_clone = cache.clone();
    let _update_handle = tokio::spawn(async move {
        let mut counter = 0;
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;

            // Update volume
            let cache_write = cache_clone.write().await;
            if let Some(mut game_sink) = cache_write.sinks.get_mut("Game") {
                counter += 1;
                game_sink.volume = 0.5 + (counter % 5) as f32 * 0.1;
                debug!("Updated Game volume to {}", game_sink.volume);
            }

            // Toggle Discord active state
            if let Some(mut discord) = cache_write.apps.get_mut("Discord") {
                discord.active = !discord.active;
                debug!("Toggled Discord active to {}", discord.active);
            }

            cache_write.increment_generation();
        }
    });

    info!("Test daemon running.");
    info!("  Shared memory: /dev/shm/pipewire-volume-mixer-{}", Uid::current());
    info!("  IPC socket: /run/user/{}/pipewire-volume-mixer.sock", Uid::current());
    info!("Press Ctrl+C to stop");

    // Wait for Ctrl+C
    tokio::signal::ctrl_c().await?;
    info!("Shutting down...");

    Ok(())
}
