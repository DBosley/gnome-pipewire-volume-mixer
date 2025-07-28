use anyhow::{Context as AnyhowContext, Result};
use pipewire::context::Context;
use pipewire::main_loop::MainLoop;
use pipewire::types::ObjectType;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::{mpsc, Arc};
use tokio::sync::RwLock;
use tracing::{debug, error, info};

use crate::cache::{AppInfo, AudioCache, SinkInfo};
use crate::config::Config;

pub struct PipeWireMonitor {
    cache: Arc<RwLock<AudioCache>>,
    config: Config,
}

enum CacheUpdate {
    UpdateSink(String, SinkInfo),
    MarkAppInactive(u32),                   // sink_input_id
    AddSinkInputToApp(String, u32, String), // app_display_name, sink_input_id, current_sink
    CheckRoutingRule(String, u32),          // app_name, sink_input_id
}

struct MonitorState {
    cache_tx: mpsc::Sender<CacheUpdate>,
    config: Config,
    nodes: HashMap<u32, NodeInfo>,
}

struct NodeInfo {
    app_name: Option<String>,
    serial_id: u32, // object.serial used as sink_input_id
}

impl PipeWireMonitor {
    pub fn new(cache: Arc<RwLock<AudioCache>>, config: Config) -> Result<Self> {
        Ok(Self { cache, config })
    }

    pub async fn run(self) -> Result<()> {
        // PipeWire requires running in its own thread with MainLoop
        let (tx, rx) = tokio::sync::oneshot::channel();

        std::thread::spawn(move || {
            if let Err(e) = run_pipewire_loop(self.cache, self.config) {
                error!("PipeWire loop error: {}", e);
                let _ = tx.send(Err(e));
            } else {
                let _ = tx.send(Ok(()));
            }
        });

        rx.await.with_context(|| "PipeWire thread panicked")?
    }
}

fn run_pipewire_loop(cache: Arc<RwLock<AudioCache>>, config: Config) -> Result<()> {
    pipewire::init();

    let mainloop = MainLoop::new(None)?;
    let context = Context::new(&mainloop)?;
    let core = context.connect(None)?;
    let registry = core.get_registry()?;

    // Create channel for cache updates
    let (cache_tx, cache_rx) = mpsc::channel();

    // Spawn a task to handle cache updates
    let cache_clone = cache.clone();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            while let Ok(update) = cache_rx.recv() {
                let cache = cache_clone.write().await;
                match update {
                    CacheUpdate::UpdateSink(name, info) => cache.update_sink(name, info),
                    CacheUpdate::MarkAppInactive(sink_input_id) => {
                        // Find the app that has this sink_input_id
                        for mut entry in cache.apps.iter_mut() {
                            let (app_name, app) = entry.pair_mut();
                            if app.sink_input_ids.contains(&sink_input_id) {
                                app.sink_input_ids.retain(|&x| x != sink_input_id);
                                // If no more active streams, mark as inactive with timestamp
                                if app.sink_input_ids.is_empty() {
                                    app.active = false;
                                    app.inactive_since = Some(std::time::Instant::now());
                                    info!("App {} is now inactive, will be removed in 5 minutes if not used", app_name);
                                }
                                break;
                            }
                        }
                    }
                    CacheUpdate::AddSinkInputToApp(app_name, sink_input_id, current_sink) => {
                        if let Some(mut app) = cache.apps.get_mut(&app_name) {
                            if !app.sink_input_ids.contains(&sink_input_id) {
                                app.sink_input_ids.push(sink_input_id);
                            }
                            // Mark as active and clear inactive timestamp
                            app.active = true;
                            app.inactive_since = None;
                            // Update sink if it's different (in case of multiple streams)
                            if app.current_sink != current_sink && app.current_sink != "Unknown" {
                                debug!("App {} has streams in multiple sinks", app_name);
                            }
                        } else {
                            // App doesn't exist yet, create it with minimal info
                            let app_info = AppInfo {
                                display_name: app_name.clone(),
                                binary_name: app_name.to_lowercase(),
                                current_sink,
                                active: true,
                                sink_input_ids: vec![sink_input_id],
                                inactive_since: None,
                            };
                            cache.update_app(app_name, app_info);
                        }
                        cache.increment_generation();
                    }
                    CacheUpdate::CheckRoutingRule(app_name, sink_input_id) => {
                        // Check if we have a routing rule for this app
                        if let Some(target_sink) = cache.routing_rules.get(&app_name) {
                            let target_sink_name = target_sink.clone();
                            info!("Applying routing rule: {} -> {}", app_name, target_sink_name);

                            // Move the sink input to the target sink
                            tokio::spawn(async move {
                                // Find the sink ID for the target
                                if let Ok(output) = tokio::process::Command::new("pactl")
                                    .args(["list", "sinks", "short"])
                                    .output()
                                    .await
                                {
                                    let stdout = String::from_utf8_lossy(&output.stdout);
                                    for line in stdout.lines() {
                                        let parts: Vec<&str> = line.split_whitespace().collect();
                                        if parts.len() >= 2 && parts[1] == target_sink_name {
                                            if let Ok(sink_id) = parts[0].parse::<u32>() {
                                                // Move the sink input
                                                let _ = std::process::Command::new("pactl")
                                                    .args([
                                                        "move-sink-input",
                                                        &sink_input_id.to_string(),
                                                        &sink_id.to_string(),
                                                    ])
                                                    .output();
                                                info!(
                                                    "Routed {} (input #{}) to {} (sink #{})",
                                                    app_name,
                                                    sink_input_id,
                                                    target_sink_name,
                                                    sink_id
                                                );
                                                break;
                                            }
                                        }
                                    }
                                }
                            });
                        }
                    }
                }
            }
        });
    });

    let state = Rc::new(RefCell::new(MonitorState { cache_tx, config, nodes: HashMap::new() }));

    // Listen for global objects
    let _listener = registry
        .add_listener_local()
        .global({
            let state = state.clone();
            move |global| {
                if let Some(props) = global.props.as_ref() {
                    handle_global(&state, global.id, props, global.type_.clone());
                }
            }
        })
        .global_remove({
            let state = state.clone();
            move |id| handle_global_remove(&state, id)
        })
        .register();

    info!("PipeWire monitor started");
    mainloop.run();

    Ok(())
}

fn handle_global(
    state: &Rc<RefCell<MonitorState>>,
    id: u32,
    properties: &pipewire::spa::utils::dict::DictRef,
    object_type: ObjectType,
) {
    let mut state = state.borrow_mut();

    // We're interested in nodes (audio streams and sinks)
    if object_type != ObjectType::Node {
        return;
    }

    let props = properties;
    let node_name = props.get("node.name").unwrap_or_default();

    // Check if this is a virtual sink
    let media_class = props.get("media.class").unwrap_or_default();
    debug!("Checking node: {} (class: {})", node_name, media_class);

    // Check if this is an audio sink
    if media_class == "Audio/Sink" {
        // Check if it's one of our virtual sinks
        if state.config.virtual_sinks.iter().any(|s| s.name == node_name) {
            // Store the sink with ID, we'll get the actual volume separately
            let sink_info = SinkInfo { id, name: node_name.to_string(), volume: 1.0, muted: false };

            // Update cache asynchronously
            let _ = state.cache_tx.send(CacheUpdate::UpdateSink(node_name.to_string(), sink_info));

            info!("Found virtual sink: {} (id: {})", node_name, id);

            // Get actual volume asynchronously
            let sink_id = id;
            let sink_name = node_name.to_string();
            let cache_tx = state.cache_tx.clone();

            std::thread::spawn(move || {
                // Get actual volume using wpctl
                if let Ok(output) = std::process::Command::new("wpctl")
                    .args(["get-volume", &sink_id.to_string()])
                    .output()
                {
                    if output.status.success() {
                        let stdout = String::from_utf8_lossy(&output.stdout);
                        // Parse output like "Volume: 0.75 [MUTED]" or "Volume: 0.75"
                        if let Some(volume_str) = stdout.split(':').nth(1) {
                            let parts: Vec<&str> = volume_str.split_whitespace().collect();
                            if let Ok(volume) = parts.first().unwrap_or(&"1.0").parse::<f32>() {
                                let muted = volume_str.contains("[MUTED]");
                                let sink_info = SinkInfo {
                                    id: sink_id,
                                    name: sink_name.clone(),
                                    volume,
                                    muted,
                                };
                                let _ =
                                    cache_tx.send(CacheUpdate::UpdateSink(sink_name, sink_info));
                            }
                        }
                    }
                }
            });
        }
    }

    // Check if this is an audio output stream (ignore input streams)
    if media_class == "Stream/Output/Audio" {
        // Skip loopback streams (check multiple properties)
        if node_name.contains("_to_") || node_name.ends_with("_Loopback") {
            return;
        }

        // Also check media.name for loopback patterns
        if let Some(media_name) = props.get("media.name") {
            if media_name.contains("Loopback") {
                return;
            }
        }

        let app_name = props
            .get("application.name")
            .or_else(|| props.get("node.description"))
            .unwrap_or_default()
            .to_string();

        // Binary name extraction will happen in the async thread with pactl

        // Get object.serial for pactl lookup
        let serial_id =
            props.get("object.serial").and_then(|s| s.parse::<u32>().ok()).unwrap_or(id);

        // We'll determine the final name later after checking pactl
        let node_info = NodeInfo { app_name: Some(app_name.clone()), serial_id };

        state.nodes.insert(id, node_info);

        // Auto-routing will be handled after we know the binary name

        // Get sink connection info asynchronously
        let app_id = serial_id;
        let app_name_for_log = app_name.clone();
        let cache_tx = state.cache_tx.clone();

        std::thread::spawn(move || {
            debug!("Looking up sink for app {} with ID {}", app_name_for_log, app_id);

            // Also try to get the binary name from pactl (more complete than PipeWire properties)
            let mut extracted_binary_name = None;
            if let Ok(pactl_output) =
                std::process::Command::new("pactl").args(["list", "sink-inputs"]).output()
            {
                if pactl_output.status.success() {
                    let stdout = String::from_utf8_lossy(&pactl_output.stdout);
                    let search_pattern = format!("Sink Input #{app_id}");
                    if let Some(pos) = stdout.find(&search_pattern) {
                        // Look for application.process.binary in the next several lines
                        let lines = stdout[pos..].lines().take(30);
                        for line in lines {
                            if let Some(binary_line) =
                                line.trim().strip_prefix("application.process.binary = \"")
                            {
                                if let Some(binary_end) = binary_line.find('"') {
                                    let binary_path = &binary_line[..binary_end];
                                    let extracted = binary_path
                                        .split('/')
                                        .next_back()
                                        .unwrap_or(binary_path)
                                        .trim_end_matches("-bin")
                                        .trim_end_matches(".exe");
                                    if !extracted.is_empty() {
                                        extracted_binary_name = Some(extracted.to_string());
                                        debug!("Found binary name from pactl: {}", extracted);
                                    }
                                    break;
                                }
                            }
                        }
                    }
                }
            }

            // Get sink info using pactl
            if let Ok(output) =
                std::process::Command::new("pactl").args(["list", "sink-inputs"]).output()
            {
                if output.status.success() {
                    let stdout = String::from_utf8_lossy(&output.stdout);

                    // Find our sink input by ID
                    let search_pattern = format!("Sink Input #{app_id}");
                    if let Some(pos) = stdout.find(&search_pattern) {
                        // Look for the Sink: line in the next several lines
                        let lines = stdout[pos..].lines().take(10);
                        for line in lines {
                            if let Some(sink_id_str) = line.trim().strip_prefix("Sink:") {
                                if let Ok(sink_id) = sink_id_str.trim().parse::<u32>() {
                                    // Get sink name
                                    if let Ok(sink_output) = std::process::Command::new("pactl")
                                        .args(["list", "sinks"])
                                        .output()
                                    {
                                        let sink_stdout =
                                            String::from_utf8_lossy(&sink_output.stdout);
                                        let sink_search = format!("Sink #{sink_id}");
                                        if let Some(sink_pos) = sink_stdout.find(&sink_search) {
                                            // Find the Name: line
                                            for line in sink_stdout[sink_pos..].lines().take(10) {
                                                if let Some(name) =
                                                    line.trim().strip_prefix("Name:")
                                                {
                                                    let sink_name = name.trim().to_string();
                                                    info!(
                                                        "Found app {} connected to sink {}",
                                                        app_name_for_log, sink_name
                                                    );
                                                    // Use extracted binary name if available, otherwise fall back
                                                    let final_display_name = extracted_binary_name
                                                        .as_ref()
                                                        .map(|name| {
                                                            // Capitalize first letter
                                                            let mut chars = name.chars();
                                                            match chars.next() {
                                                                None => String::new(),
                                                                Some(first) => {
                                                                    first
                                                                        .to_uppercase()
                                                                        .collect::<String>()
                                                                        + chars.as_str()
                                                                }
                                                            }
                                                        })
                                                        .unwrap_or_else(|| {
                                                            app_name_for_log.clone()
                                                        });

                                                    // Use the capitalized display name as the key for consistency
                                                    let final_key = final_display_name.clone();

                                                    // Always use AddSinkInputToApp - it will create the app if needed
                                                    let _ = cache_tx.send(
                                                        CacheUpdate::AddSinkInputToApp(
                                                            final_key.clone(),
                                                            app_id,
                                                            sink_name,
                                                        ),
                                                    );

                                                    // Check if we need to apply a routing rule
                                                    let _ = cache_tx.send(
                                                        CacheUpdate::CheckRoutingRule(
                                                            final_key, app_id,
                                                        ),
                                                    );
                                                    return;
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // Fallback if we couldn't get sink info
            let final_display_name = extracted_binary_name
                .as_ref()
                .map(|name| {
                    // Capitalize first letter
                    let mut chars = name.chars();
                    match chars.next() {
                        None => String::new(),
                        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                    }
                })
                .unwrap_or_else(|| app_name_for_log.clone());

            // Use the capitalized display name as the key for consistency
            let final_key = final_display_name.clone();

            // Always use AddSinkInputToApp - it will create the app if needed
            let _ = cache_tx.send(CacheUpdate::AddSinkInputToApp(
                final_key.clone(),
                app_id,
                "Unknown".to_string(),
            ));

            // Check if we need to apply a routing rule
            let _ = cache_tx.send(CacheUpdate::CheckRoutingRule(final_key, app_id));
        });
    }
}

fn handle_global_remove(state: &Rc<RefCell<MonitorState>>, id: u32) {
    let mut state = state.borrow_mut();

    if let Some(node_info) = state.nodes.remove(&id) {
        if let Some(app_name) = node_info.app_name {
            let app_name_for_log = app_name.clone();
            // Mark app as inactive in cache using the serial_id
            let _ = state.cache_tx.send(CacheUpdate::MarkAppInactive(node_info.serial_id));

            info!("Audio stream removed: {} (id: {})", app_name_for_log, id);
        }
    }
}
