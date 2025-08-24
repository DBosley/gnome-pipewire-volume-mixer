use anyhow::Result;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};

use crate::cache::AudioCache;

/// Controller for PipeWire operations
/// This module handles the actual PipeWire control operations
pub struct PipeWireController {
    cache: Arc<RwLock<AudioCache>>,
}

impl PipeWireController {
    pub fn new(cache: Arc<RwLock<AudioCache>>) -> Self {
        Self { cache }
    }

    /// Set volume for a virtual sink
    pub async fn set_sink_volume(&self, sink_name: &str, volume: f32) -> Result<()> {
        debug!("Setting volume for sink {} to {}", sink_name, volume);

        // Get the PipeWire ID for this sink
        let pipewire_id = {
            let cache = self.cache.read().await;
            cache
                .sinks
                .get(sink_name)
                .map(|s| s.pipewire_id)
                .ok_or_else(|| anyhow::anyhow!("Sink {} not found", sink_name))?
        };

        let volume_percent = (volume * 100.0) as u32;

        // First set the sink volume (for completeness)
        let output = tokio::process::Command::new("pactl")
            .args(["set-sink-volume", &pipewire_id.to_string(), &format!("{volume_percent}%")])
            .output()
            .await?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            error!("Failed to set sink volume: {}", stderr);
            // Don't fail here, try to set loopback volume anyway
        }

        // More importantly, find and set the loopback stream volume
        // This is what actually controls the audio output
        let pactl_output =
            tokio::process::Command::new("pactl").args(["list", "sink-inputs"]).output().await?;

        if pactl_output.status.success() {
            let stdout = String::from_utf8_lossy(&pactl_output.stdout);
            let blocks: Vec<&str> = stdout.split("Sink Input #").collect();

            for block in blocks {
                // Look for the loopback stream (e.g., "Game_to_Speaker" for "Game" sink)
                if block.contains(&format!("node.name = \"{sink_name}_to_Speaker\"")) {
                    if let Some(id_match) = block.lines().next().and_then(|line| {
                        line.split_whitespace().next().and_then(|s| s.parse::<u32>().ok())
                    }) {
                        debug!("Found loopback stream {} for sink {}", id_match, sink_name);

                        // Set loopback volume - this is what actually controls the audio
                        let loopback_output = tokio::process::Command::new("pactl")
                            .args([
                                "set-sink-input-volume",
                                &id_match.to_string(),
                                &format!("{volume_percent}%"),
                            ])
                            .output()
                            .await?;

                        if !loopback_output.status.success() {
                            let stderr = String::from_utf8_lossy(&loopback_output.stderr);
                            error!("Failed to set loopback volume: {}", stderr);
                        } else {
                            debug!(
                                "Successfully set loopback stream {} volume to {}%",
                                id_match, volume_percent
                            );
                        }

                        break;
                    }
                }
            }
        }

        // Update cache
        {
            let cache = self.cache.write().await;
            if let Some(mut sink) = cache.sinks.get_mut(sink_name) {
                sink.volume = volume;
            };
        }

        Ok(())
    }

    /// Set mute state for a virtual sink
    pub async fn set_sink_mute(&self, sink_name: &str, muted: bool) -> Result<()> {
        debug!("Setting mute for sink {} to {}", sink_name, muted);

        // Get the PipeWire ID for this sink
        let pipewire_id = {
            let cache = self.cache.read().await;
            cache
                .sinks
                .get(sink_name)
                .map(|s| s.pipewire_id)
                .ok_or_else(|| anyhow::anyhow!("Sink {} not found", sink_name))?
        };

        let mute_arg = if muted { "1" } else { "0" };

        // First set the sink mute (for completeness)
        let output = tokio::process::Command::new("pactl")
            .args(["set-sink-mute", &pipewire_id.to_string(), mute_arg])
            .output()
            .await?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            error!("Failed to set sink mute: {}", stderr);
            // Don't fail here, try to set loopback mute anyway
        }

        // More importantly, find and mute/unmute the loopback stream
        // This is what actually controls the audio output
        let pactl_output =
            tokio::process::Command::new("pactl").args(["list", "sink-inputs"]).output().await?;

        if pactl_output.status.success() {
            let stdout = String::from_utf8_lossy(&pactl_output.stdout);
            let blocks: Vec<&str> = stdout.split("Sink Input #").collect();

            for block in blocks {
                // Look for the loopback stream (e.g., "Game_to_Speaker" for "Game" sink)
                if block.contains(&format!("node.name = \"{sink_name}_to_Speaker\"")) {
                    if let Some(id_match) = block.lines().next().and_then(|line| {
                        line.split_whitespace().next().and_then(|s| s.parse::<u32>().ok())
                    }) {
                        debug!("Found loopback stream {} for sink {}", id_match, sink_name);

                        // Set loopback mute - this is what actually controls the audio
                        let loopback_output = tokio::process::Command::new("pactl")
                            .args(["set-sink-input-mute", &id_match.to_string(), mute_arg])
                            .output()
                            .await?;

                        if !loopback_output.status.success() {
                            let stderr = String::from_utf8_lossy(&loopback_output.stderr);
                            error!("Failed to set loopback mute: {}", stderr);
                        } else {
                            debug!(
                                "Successfully set loopback stream {} mute to {}",
                                id_match, muted
                            );
                        }

                        break;
                    }
                }
            }
        }

        // Update cache
        {
            let cache = self.cache.write().await;
            if let Some(mut sink) = cache.sinks.get_mut(sink_name) {
                sink.muted = muted;
            };
        }

        Ok(())
    }

    /// Route an application to a different sink
    pub async fn route_app(&self, app_name: &str, sink_name: &str) -> Result<()> {
        debug!("Routing app {} to sink {}", app_name, sink_name);

        // First, refresh the sink input IDs by checking pactl
        let fresh_sink_input_ids = self.get_fresh_sink_input_ids(app_name).await?;

        if fresh_sink_input_ids.is_empty() {
            return Err(anyhow::anyhow!("App {} has no active sink inputs", app_name));
        }

        // Verify the sink exists in cache
        {
            let cache = self.cache.read().await;
            if !cache.sinks.contains_key(sink_name) {
                return Err(anyhow::anyhow!("Sink {} not found", sink_name));
            }
        }

        // Update cache with fresh IDs
        let sink_input_ids = {
            let cache = self.cache.write().await;
            if let Some(mut app) = cache.apps.get_mut(app_name) {
                app.sink_input_ids = fresh_sink_input_ids.clone();
            }
            fresh_sink_input_ids
        };

        // Move all sink inputs for this app to the new sink
        // Use the sink NAME not the ID since pactl and pipewire IDs don't match
        for sink_input_id in &sink_input_ids {
            debug!("Moving sink input {} to sink {}", sink_input_id, sink_name);
            let output = tokio::process::Command::new("pactl")
                .args(["move-sink-input", &sink_input_id.to_string(), sink_name])
                .output()
                .await?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                error!("Failed to route sink input {}: {}", sink_input_id, stderr);
                return Err(anyhow::anyhow!("pactl command failed: {}", stderr));
            }
        }

        // Wait a moment for PipeWire to process the change
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        // Now verify the actual sink connection and update cache
        // This is important because module-stream-restore might move it back
        let actual_sink = self.get_app_actual_sink(app_name, &sink_input_ids).await;

        // Log if it didn't stick
        if let Some(ref actual) = actual_sink {
            if actual != sink_name {
                warn!(
                    "App {} was routed to {} but ended up on {} (possibly due to stream-restore)",
                    app_name, sink_name, actual
                );
            }
        }

        {
            let cache = self.cache.write().await;
            if let Some(mut app) = cache.apps.get_mut(app_name) {
                // Update with the actual sink we detected
                if let Some(ref actual) = actual_sink {
                    app.current_sink = actual.clone();
                } else {
                    // Fallback to what we requested
                    app.current_sink = sink_name.to_string();
                }
            }

            // Also update remembered apps
            cache
                .remembered_apps
                .insert(app_name.to_string(), actual_sink.unwrap_or_else(|| sink_name.to_string()));
        }

        info!("Routed {} to {}", app_name, sink_name);
        Ok(())
    }

    /// Get fresh sink input IDs for an app from pactl
    async fn get_fresh_sink_input_ids(&self, app_name: &str) -> Result<Vec<u32>> {
        debug!("Refreshing sink input IDs for app {}", app_name);

        // Get stream names from cache if available
        let stream_names = {
            let cache = self.cache.read().await;
            cache.apps.get(app_name).map(|app| app.stream_names.clone()).unwrap_or_default()
        };

        let output =
            tokio::process::Command::new("pactl").args(["list", "sink-inputs"]).output().await?;

        if !output.status.success() {
            return Err(anyhow::anyhow!("Failed to list sink inputs"));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut sink_input_ids = Vec::new();
        let app_name_lower = app_name.to_lowercase();

        // Parse sink inputs to find all streams for our app
        let mut current_id = None;
        let mut in_properties = false;
        let mut current_app_name = String::new();
        let mut current_binary_name = String::new();

        for line in stdout.lines() {
            if let Some(id_str) = line.strip_prefix("Sink Input #") {
                // Process previous sink input if it matches
                if let Some(id) = current_id {
                    // Check if this stream matches our app name, binary name, or any stored stream names
                    let matches_stream_name = stream_names
                        .iter()
                        .any(|stream| stream.to_lowercase() == current_app_name.to_lowercase());

                    // Special case: WEBRTC VoiceEngine with Discord binary should be grouped with Discord
                    if (current_app_name.to_lowercase().contains("webrtc")
                        && current_binary_name.to_lowercase() == app_name_lower)
                        || current_app_name.to_lowercase() == app_name_lower
                        || current_binary_name.to_lowercase() == app_name_lower
                        || matches_stream_name
                    {
                        debug!(
                            "Found {} sink input: {} (app: {}, binary: {})",
                            app_name, id, current_app_name, current_binary_name
                        );
                        sink_input_ids.push(id);
                    }
                }

                // Reset for new sink input
                current_id = id_str.parse::<u32>().ok();
                in_properties = false;
                current_app_name.clear();
                current_binary_name.clear();
            } else if line.trim() == "Properties:" {
                in_properties = true;
            } else if in_properties && current_id.is_some() {
                // Collect application.name
                if let Some(name_line) = line.trim().strip_prefix("application.name = \"") {
                    if let Some(name_end) = name_line.find('"') {
                        current_app_name = name_line[..name_end].to_string();
                    }
                }

                // Collect application.process.binary
                if let Some(binary_line) =
                    line.trim().strip_prefix("application.process.binary = \"")
                {
                    if let Some(binary_end) = binary_line.find('"') {
                        let binary_path = &binary_line[..binary_end];
                        current_binary_name = binary_path
                            .split('/')
                            .next_back()
                            .unwrap_or(binary_path)
                            .trim_end_matches("-bin")
                            .trim_end_matches(".exe")
                            .to_string();
                    }
                }
            }
        }

        // Don't forget the last sink input
        if let Some(id) = current_id {
            let matches_stream_name = stream_names
                .iter()
                .any(|stream| stream.to_lowercase() == current_app_name.to_lowercase());

            if (current_app_name.to_lowercase().contains("webrtc")
                && current_binary_name.to_lowercase() == app_name_lower)
                || current_app_name.to_lowercase() == app_name_lower
                || current_binary_name.to_lowercase() == app_name_lower
                || matches_stream_name
            {
                debug!(
                    "Found {} sink input: {} (app: {}, binary: {})",
                    app_name, id, current_app_name, current_binary_name
                );
                sink_input_ids.push(id);
            }
        }

        debug!("Found {} active sink inputs for {}", sink_input_ids.len(), app_name);
        Ok(sink_input_ids)
    }

    /// Get the actual sink an app is connected to by checking PipeWire
    async fn get_app_actual_sink(&self, app_name: &str, sink_input_ids: &[u32]) -> Option<String> {
        debug!("Checking actual sink for app {} with sink inputs {:?}", app_name, sink_input_ids);
        if sink_input_ids.is_empty() {
            return None;
        }

        // Use pactl to check the actual sink connection
        let output = tokio::process::Command::new("pactl")
            .args(["list", "sink-inputs"])
            .output()
            .await
            .ok()?;

        if !output.status.success() {
            return None;
        }

        let stdout = String::from_utf8_lossy(&output.stdout);

        // Look for the first sink input ID and get its sink
        for sink_input_id in sink_input_ids {
            let search_pattern = format!("Sink Input #{sink_input_id}");
            if let Some(pos) = stdout.find(&search_pattern) {
                // Look for the Sink: line in the next few lines
                let lines = stdout[pos..].lines().take(20);
                let mut found_sink_id = None;
                for line in lines {
                    if let Some(sink_line) = line.trim().strip_prefix("Sink: ") {
                        // Get the sink ID (it's a number)
                        if let Ok(sink_id) = sink_line.parse::<u32>() {
                            found_sink_id = Some(sink_id);
                            debug!("Found app {} connected to sink ID {}", app_name, sink_id);
                            break;
                        }
                    }
                }

                // Now get the sink name from pactl
                if let Some(sink_id) = found_sink_id {
                    let sink_output = tokio::process::Command::new("pactl")
                        .args(["list", "sinks", "short"])
                        .output()
                        .await
                        .ok()?;

                    if sink_output.status.success() {
                        let sink_stdout = String::from_utf8_lossy(&sink_output.stdout);
                        for line in sink_stdout.lines() {
                            let parts: Vec<&str> = line.split_whitespace().collect();
                            if parts.len() >= 2 {
                                if let Ok(id) = parts[0].parse::<u32>() {
                                    if id == sink_id {
                                        let sink_name = parts[1];
                                        debug!(
                                            "Sink ID {} maps to sink name {}",
                                            sink_id, sink_name
                                        );
                                        return Some(sink_name.to_string());
                                    }
                                }
                            }
                        }
                    }
                    warn!("Could not find sink name for sink ID {} in pactl", sink_id);
                }
            }
        }

        None
    }
}
