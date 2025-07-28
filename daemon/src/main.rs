use anyhow::Result;
use clap::Parser;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, error, info};

mod cache;
mod config;
mod ipc;
mod pipewire_monitor;
mod shared_memory;

use cache::AudioCache;
use config::Config;
use ipc::IpcServer;
use pipewire_monitor::PipeWireMonitor;
use shared_memory::SharedMemoryWriter;

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

    // Initialize shared cache
    let cache = Arc::new(RwLock::new(AudioCache::new()));

    // Initialize shared memory writer
    let shm_writer = SharedMemoryWriter::new(cache.clone())?;

    // Start shared memory update loop
    let shm_handle = tokio::spawn(async move {
        shm_writer.run().await;
    });

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
                if count > 0 {
                    debug!("Found {} inactive apps: {:?}", count, inactive_apps);
                }
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
    let pw_monitor = PipeWireMonitor::new(cache.clone(), config)?;

    // Run PipeWire monitor in main thread
    info!("Starting PipeWire monitoring");
    pw_monitor.run().await?;

    // Wait for tasks to complete (they shouldn't unless there's an error)
    tokio::try_join!(shm_handle, ipc_handle, cleanup_handle)?;

    Ok(())
}
