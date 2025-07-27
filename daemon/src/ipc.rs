use anyhow::{bail, Context, Result};
use nix::unistd::Uid;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::RwLock;
use tracing::{debug, error, info};

use crate::cache::AudioCache;

pub struct IpcServer {
    cache: Arc<RwLock<AudioCache>>,
    listener: UnixListener,
}

impl IpcServer {
    pub fn new(cache: Arc<RwLock<AudioCache>>) -> Result<Self> {
        let uid = Uid::current();
        let socket_path = format!("/run/user/{uid}/pipewire-volume-mixer.sock");

        // Remove existing socket if it exists
        let _ = std::fs::remove_file(&socket_path);

        // Create the socket
        let listener = UnixListener::bind(&socket_path).context("Failed to bind Unix socket")?;

        info!("IPC server listening on {}", socket_path);

        Ok(Self { cache, listener })
    }

    pub async fn run(self) -> Result<()> {
        loop {
            match self.listener.accept().await {
                Ok((stream, _)) => {
                    let cache = self.cache.clone();
                    tokio::spawn(async move {
                        if let Err(e) = handle_client(stream, cache).await {
                            error!("Client handler error: {}", e);
                        }
                    });
                }
                Err(e) => {
                    error!("Failed to accept connection: {}", e);
                }
            }
        }
    }
}

async fn handle_client(stream: UnixStream, cache: Arc<RwLock<AudioCache>>) -> Result<()> {
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let mut line = String::new();

    while reader.read_line(&mut line).await? > 0 {
        let response = match process_command(line.trim(), &cache).await {
            Ok(msg) => format!("OK {msg}\n"),
            Err(e) => format!("ERROR {e}\n"),
        };

        writer.write_all(response.as_bytes()).await?;
        line.clear();
    }

    Ok(())
}

async fn process_command(command: &str, cache: &Arc<RwLock<AudioCache>>) -> Result<String> {
    let parts: Vec<&str> = command.split_whitespace().collect();
    if parts.is_empty() {
        bail!("Empty command");
    }

    debug!("Processing command: {}", command);

    match parts[0] {
        "ROUTE" => {
            if parts.len() != 3 {
                bail!("Usage: ROUTE <app_name> <sink_name>");
            }

            let app_name = parts[1];
            let sink_name = parts[2];

            // Update routing rule
            cache.write().await.routing_rules.insert(app_name.to_string(), sink_name.to_string());

            // TODO: Actually move the stream in PipeWire
            // This will be implemented in pipewire_monitor.rs

            Ok(format!("Routed {app_name} to {sink_name}"))
        }

        "SET_VOLUME" => {
            if parts.len() != 3 {
                bail!("Usage: SET_VOLUME <sink_name> <volume>");
            }

            let sink_name = parts[1];
            let volume: f32 = parts[2].parse().context("Invalid volume value")?;

            if !(0.0..=1.0).contains(&volume) {
                bail!("Volume must be between 0.0 and 1.0");
            }

            // Update cache and get sink ID
            let cache_write = cache.write().await;
            let sink_id = match cache_write.sinks.get_mut(sink_name) {
                Some(mut sink) => {
                    let id = sink.id;
                    sink.volume = volume;
                    id
                }
                None => bail!("Unknown sink: {}", sink_name),
            };
            drop(cache_write);

            // Actually set volume in PipeWire
            // First set the sink volume
            let volume_percent = (volume * 100.0) as u32;
            let output = tokio::process::Command::new("wpctl")
                .args(["set-volume", &sink_id.to_string(), &format!("{volume_percent}%")])
                .output()
                .await?;

            if !output.status.success() {
                bail!("Failed to set sink volume: {}", String::from_utf8_lossy(&output.stderr));
            }

            // Then find and set the loopback sink-input volume
            let pactl_output = tokio::process::Command::new("pactl")
                .args(["list", "sink-inputs"])
                .output()
                .await?;

            if pactl_output.status.success() {
                let stdout = String::from_utf8_lossy(&pactl_output.stdout);
                let blocks: Vec<&str> = stdout.split("Sink Input #").collect();

                for block in blocks {
                    if block.contains(&format!("node.name = \"{sink_name}_to_Speaker\"")) {
                        if let Some(id_match) = block.lines().next().and_then(|line| {
                            line.split_whitespace().next().and_then(|s| s.parse::<u32>().ok())
                        }) {
                            // Set loopback volume
                            let _ = tokio::process::Command::new("pactl")
                                .args([
                                    "set-sink-input-volume",
                                    &id_match.to_string(),
                                    &format!("{volume_percent}%"),
                                ])
                                .output()
                                .await;
                            break;
                        }
                    }
                }
            }

            Ok(format!("Set {sink_name} volume to {volume}"))
        }

        "MUTE" => {
            if parts.len() != 3 {
                bail!("Usage: MUTE <sink_name> <true|false>");
            }

            let sink_name = parts[1];
            let muted: bool = parts[2].parse().context("Invalid mute value")?;

            // Update cache and get sink ID
            let cache_write = cache.write().await;
            let sink_id = match cache_write.sinks.get_mut(sink_name) {
                Some(mut sink) => {
                    let id = sink.id;
                    sink.muted = muted;
                    id
                }
                None => bail!("Unknown sink: {}", sink_name),
            };
            drop(cache_write);

            // Actually set mute in PipeWire
            // First set the sink mute
            let mute_arg = if muted { "1" } else { "0" };
            let output = tokio::process::Command::new("wpctl")
                .args(["set-mute", &sink_id.to_string(), mute_arg])
                .output()
                .await?;

            if !output.status.success() {
                bail!("Failed to set sink mute: {}", String::from_utf8_lossy(&output.stderr));
            }

            // Then find and mute/unmute the loopback sink-input
            let pactl_output = tokio::process::Command::new("pactl")
                .args(["list", "sink-inputs"])
                .output()
                .await?;

            if pactl_output.status.success() {
                let stdout = String::from_utf8_lossy(&pactl_output.stdout);
                let blocks: Vec<&str> = stdout.split("Sink Input #").collect();

                for block in blocks {
                    if block.contains(&format!("node.name = \"{sink_name}_to_Speaker\"")) {
                        if let Some(id_match) = block.lines().next().and_then(|line| {
                            line.split_whitespace().next().and_then(|s| s.parse::<u32>().ok())
                        }) {
                            // Set loopback mute
                            let _ = tokio::process::Command::new("pactl")
                                .args(["set-sink-input-mute", &id_match.to_string(), mute_arg])
                                .output()
                                .await;
                            break;
                        }
                    }
                }
            }

            Ok(format!("Set {sink_name} muted to {muted}"))
        }

        "RELOAD_CONFIG" => {
            // TODO: Implement config reload
            Ok("Config reloaded".to_string())
        }

        _ => {
            bail!("Unknown command: {}", parts[0]);
        }
    }
}
