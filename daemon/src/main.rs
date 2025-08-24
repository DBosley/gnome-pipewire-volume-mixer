use anyhow::Result;
use clap::Parser;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, error, info};

mod cache;
mod config;
mod dbus_service;
mod ipc;
mod pipewire_controller;
mod pipewire_monitor;

use cache::AudioCache;
use config::{AppMappings, Config};
use dbus_service::start_dbus_service;
use ipc::IpcServer;
use pipewire_controller::PipeWireController;
use pipewire_monitor::PipeWireMonitor;

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// Configuration file path
    #[arg(short, long, default_value = "/etc/pipewire-volume-mixer/config.toml")]
    config: String,

    /// Enable debug logging
    #[arg(short, long)]
    debug: bool,

    /// Run in foreground (don't daemonize)
    #[arg(short, long)]
    foreground: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();

    // Initialize logging
    let filter = if args.debug { "debug" } else { "info" };
    tracing_subscriber::fmt().with_env_filter(filter).init();

    info!("Starting PipeWire Volume Mixer Daemon");

    // Load configuration
    let config = Config::load(&args.config)?;
    debug!("Loaded configuration: {:?}", config);

    // Load app mappings from disk
    let app_mappings = match AppMappings::load() {
        Ok(mappings) => {
            info!("Loaded {} app mappings from disk", mappings.mappings.len());
            Arc::new(RwLock::new(mappings))
        }
        Err(e) => {
            error!("Failed to load app mappings: {}", e);
            Arc::new(RwLock::new(AppMappings::default()))
        }
    };

    // Initialize shared cache with loaded mappings
    let cache = Arc::new(RwLock::new(AudioCache::new()));

    // Populate cache with loaded mappings
    {
        #[allow(unused_mut)]
        let mut cache_write = cache.write().await;
        let mappings_read = app_mappings.read().await;
        for (app_name, sink_name) in &mappings_read.mappings {
            cache_write.remembered_apps.insert(app_name.clone(), sink_name.clone());
            cache_write.routing_rules.insert(app_name.clone(), sink_name.clone());
            debug!("Restored mapping: {} -> {}", app_name, sink_name);
        }
    }

    // Initialize PipeWire controller
    let controller = Arc::new(PipeWireController::new(cache.clone()));

    // Start D-Bus service
    let _dbus_connection =
        start_dbus_service(cache.clone(), controller.clone(), app_mappings.clone()).await?;
    info!("D-Bus service started on org.gnome.PipewireVolumeMixer");

    // Initialize IPC server
    let ipc_server = IpcServer::new(cache.clone())?;
    let ipc_handle = tokio::spawn(async move {
        if let Err(e) = ipc_server.run().await {
            error!("IPC server error: {}", e);
        }
    });

    // Start cleanup task for inactive apps
    let cache_cleanup = cache.clone();
    let cleanup_handle = tokio::spawn(async move {
        // Check less frequently - every 15 seconds is plenty
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(15));
        loop {
            interval.tick().await;

            // First do a quick check if there are any inactive apps at all
            let (has_inactive, inactive_count) = {
                let cache = cache_cleanup.read().await;
                let inactive_apps: Vec<_> = cache
                    .apps
                    .iter()
                    .filter(|entry| !entry.value().active)
                    .map(|entry| entry.key().clone())
                    .collect();
                let count = inactive_apps.len();
                (count > 0, count)
            };

            // Only run cleanup if there are inactive apps
            if has_inactive {
                debug!("Running cleanup for {} inactive apps", inactive_count);
                let removed = cache_cleanup.read().await.cleanup_inactive_apps(300); // 5 minutes
                if removed > 0 {
                    info!("Cleaned up {} inactive apps after 5 minute TTL", removed);
                } else {
                    debug!("No apps exceeded TTL yet");
                }
            }
        }
    });

    // Initialize PipeWire monitor
    let pw_monitor = PipeWireMonitor::new(cache.clone(), config, controller.clone())?;

    // Run PipeWire monitor in main thread
    info!("Starting PipeWire monitoring");
    pw_monitor.run().await?;

    // Wait for tasks to complete (they shouldn't unless there's an error)
    tokio::try_join!(ipc_handle, cleanup_handle)?;

    Ok(())
}
