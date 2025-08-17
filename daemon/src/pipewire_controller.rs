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

        // Use pactl to set the volume
        let volume_percent = (volume * 100.0) as u32;
        let output = tokio::process::Command::new("pactl")
            .args(["set-sink-volume", &pipewire_id.to_string(), &format!("{volume_percent}%")])
            .output()
            .await?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            error!("Failed to set volume: {}", stderr);
            return Err(anyhow::anyhow!("pactl command failed: {}", stderr));
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

        // Use pactl to set the mute state
        let mute_arg = if muted { "1" } else { "0" };
        let output = tokio::process::Command::new("pactl")
            .args(["set-sink-mute", &pipewire_id.to_string(), mute_arg])
            .output()
            .await?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            error!("Failed to set mute: {}", stderr);
            return Err(anyhow::anyhow!("pactl command failed: {}", stderr));
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

        // Get the sink-input IDs and sink ID
        let (sink_input_ids, sink_id) = {
            let cache = self.cache.read().await;
            let app = cache
                .apps
                .get(app_name)
                .ok_or_else(|| anyhow::anyhow!("App {} not found", app_name))?;

            if app.sink_input_ids.is_empty() {
                return Err(anyhow::anyhow!("App {} has no active sink inputs", app_name));
            }

            let sink_id = cache
                .sinks
                .get(sink_name)
                .map(|s| s.pipewire_id)
                .ok_or_else(|| anyhow::anyhow!("Sink {} not found", sink_name))?;
            (app.sink_input_ids.clone(), sink_id)
        };

        // Move all sink inputs for this app to the new sink
        for sink_input_id in &sink_input_ids {
            debug!("Moving sink input {} to sink {}", sink_input_id, sink_id);
            let output = tokio::process::Command::new("pactl")
                .args(["move-sink-input", &sink_input_id.to_string(), &sink_id.to_string()])
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
                let lines = stdout[pos..].lines().take(5);
                for line in lines {
                    if let Some(sink_line) = line.trim().strip_prefix("Sink: ") {
                        // Get the sink ID (it's a number)
                        if let Ok(sink_id) = sink_line.parse::<u32>() {
                            debug!("Found app {} connected to sink ID {}", app_name, sink_id);
                            // Now look up this sink ID to get its name
                            let cache = self.cache.read().await;
                            for entry in cache.sinks.iter() {
                                let sink = entry.value();
                                if sink.pipewire_id == sink_id {
                                    debug!("Sink ID {} maps to sink name {}", sink_id, sink.name);
                                    return Some(sink.name.clone());
                                }
                            }
                            warn!("Could not find sink name for sink ID {} in cache", sink_id);
                        }
                    }
                }
            }
        }

        None
    }
}
