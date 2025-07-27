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

            // Actually move the stream in PipeWire
            let result = route_app_to_sink(app_name, sink_name).await;
            match result {
                Ok(_) => {
                    // Update the app's current sink in cache properly
                    let cache_read = cache.read().await;
                    let app_clone = cache_read.apps.get(app_name).map(|app_ref| app_ref.value().clone());
                    drop(cache_read);
                    
                    if let Some(mut app) = app_clone {
                        app.current_sink = sink_name.to_string();
                        // Use the proper update method to increment generation
                        cache.write().await.update_app(app_name.to_string(), app);
                    }
                    
                    Ok(format!("Routed {app_name} to {sink_name}"))
                },
                Err(e) => bail!("Failed to route {app_name} to {sink_name}: {e}")
            }
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

async fn route_app_to_sink(app_name: &str, sink_name: &str) -> Result<()> {
    debug!("Attempting to route {} to {}", app_name, sink_name);
    
    // First, find all sink input IDs for the app
    let sink_inputs_output = tokio::process::Command::new("pactl")
        .args(["list", "sink-inputs"])
        .output()
        .await?;

    if !sink_inputs_output.status.success() {
        bail!("Failed to list sink inputs");
    }

    let stdout = String::from_utf8_lossy(&sink_inputs_output.stdout);
    let mut sink_input_ids = Vec::new();

    // Parse sink inputs to find all streams for our app
    let blocks: Vec<&str> = stdout.split("Sink Input #").collect();
    
    for block in blocks.iter().skip(1) {  // Skip first empty block
        if let Some(id_str) = block.lines().next() {
            if let Ok(id) = id_str.trim().parse::<u32>() {
                let app_name_lower = app_name.to_lowercase();
                
                // Check for application.process.binary match
                for line in block.lines() {
                    if let Some(binary_line) = line.trim().strip_prefix("application.process.binary = \"") {
                        if let Some(binary_end) = binary_line.find('"') {
                            let binary_path = &binary_line[..binary_end];
                            let binary_name = binary_path.split('/')
                                .next_back()
                                .unwrap_or(binary_path)
                                .trim_end_matches("-bin")
                                .trim_end_matches(".exe")
                                .to_lowercase();
                            
                            debug!("Checking binary name '{}' against app name '{}'", binary_name, app_name_lower);
                            
                            if binary_name == app_name_lower {
                                debug!("Found {} sink input: {} (binary match)", app_name, id);
                                sink_input_ids.push(id);
                                break;
                            }
                        }
                    }
                    // Also check application.name as fallback
                    else if line.contains("application.name = \"") {
                        if let Some(name_start) = line.find('"') {
                            let name_line = &line[name_start+1..];
                            if let Some(name_end) = name_line.find('"') {
                                let name = name_line[..name_end].to_lowercase();
                                if name.contains(&app_name_lower) {
                                    debug!("Found {} sink input: {} (name match)", app_name, id);
                                    sink_input_ids.push(id);
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // If no active streams found, this is an inactive app - just update the routing rule
    if sink_input_ids.is_empty() {
        info!("No active streams found for {}. Routing rule will apply when app starts playing.", app_name);
        return Ok(());
    }

    // Now find the sink ID for the target sink
    let sinks_output = tokio::process::Command::new("pactl")
        .args(["list", "sinks", "short"])
        .output()
        .await?;

    if !sinks_output.status.success() {
        bail!("Failed to list sinks");
    }

    let sinks_stdout = String::from_utf8_lossy(&sinks_output.stdout);
    let mut target_sink_id = None;

    for line in sinks_stdout.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 2 && parts[1] == sink_name {
            if let Ok(sink_id) = parts[0].parse::<u32>() {
                target_sink_id = Some(sink_id);
                break;
            }
        }
    }

    let sink_id = target_sink_id.ok_or_else(|| {
        anyhow::anyhow!("Could not find sink: {}", sink_name)
    })?;

    // Move all sink inputs for this app to the target sink
    let mut success_count = 0;
    let mut errors = Vec::new();
    
    for input_id in sink_input_ids {
        let move_output = tokio::process::Command::new("pactl")
            .args(["move-sink-input", &input_id.to_string(), &sink_id.to_string()])
            .output()
            .await?;

        if move_output.status.success() {
            success_count += 1;
            debug!("Moved sink input {} to {}", input_id, sink_name);
        } else {
            let error_msg = String::from_utf8_lossy(&move_output.stderr);
            errors.push(format!("Failed to move input {input_id}: {error_msg}"));
        }
    }
    
    if success_count == 0 {
        bail!("Failed to move any sink inputs: {:?}", errors);
    }

    info!("Successfully routed {} ({} streams) to {} (sink #{})", app_name, success_count, sink_name, sink_id);
    Ok(())
}
