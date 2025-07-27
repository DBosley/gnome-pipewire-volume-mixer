use anyhow::{Context as AnyhowContext, Result};
use pipewire::context::Context;
use pipewire::main_loop::MainLoop;
use pipewire::types::ObjectType;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};
use tokio::sync::RwLock;
use tracing::{debug, error, info};

use crate::cache::{AppInfo, AudioCache, SinkInfo};
use crate::config::Config;

pub struct PipeWireMonitor {
    cache: Arc<RwLock<AudioCache>>,
    config: Config,
}

enum CacheUpdate {
    UpdateApp(String, AppInfo),
    UpdateSink(String, SinkInfo),
    MarkAppInactive(String, u32),
}

struct MonitorState {
    cache_tx: mpsc::Sender<CacheUpdate>,
    config: Config,
    nodes: HashMap<u32, NodeInfo>,
    last_event: Instant,
    event_count: u64,
}

struct NodeInfo {
    app_name: Option<String>,
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
                    CacheUpdate::UpdateApp(name, info) => cache.update_app(name, info),
                    CacheUpdate::UpdateSink(name, info) => cache.update_sink(name, info),
                    CacheUpdate::MarkAppInactive(app_name, id) => {
                        if let Some(mut app) = cache.apps.get_mut(&app_name) {
                            app.active = false;
                            app.sink_input_ids.retain(|&x| x != id);
                        }
                    }
                }
            }
        });
    });

    let state = Rc::new(RefCell::new(MonitorState {
        cache_tx,
        config,
        nodes: HashMap::new(),
        last_event: Instant::now(),
        event_count: 0,
    }));

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

    // Track event rate
    state.event_count += 1;
    let now = Instant::now();
    if now.duration_since(state.last_event) > Duration::from_secs(10) {
        let rate = state.event_count as f64 / 10.0;
        debug!("PipeWire event rate: {:.1} events/sec", rate);
        state.event_count = 0;
        state.last_event = now;
    }

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
                                let _ = cache_tx.send(CacheUpdate::UpdateSink(sink_name, sink_info));
                            }
                        }
                    }
                }
            });
        }
    }

    // Check if this is an audio stream
    if media_class == "Stream/Output/Audio" || media_class == "Stream/Input/Audio" {
        // Skip loopback streams
        if node_name.contains("_to_") {
            return;
        }

        let app_name = props
            .get("application.name")
            .or_else(|| props.get("node.description"))
            .unwrap_or_default()
            .to_string();

        let binary_name = props.get("application.process.binary").map(|s| {
            s.split('/')
                .next_back()
                .unwrap_or(s)
                .trim_end_matches("-bin")
                .trim_end_matches(".exe")
                .to_string()
        });

        let display_name = binary_name
            .as_ref()
            .unwrap_or(&app_name)
            .chars()
            .take(1)
            .flat_map(char::to_uppercase)
            .chain(binary_name.as_ref().unwrap_or(&app_name).chars().skip(1))
            .collect::<String>();

        let node_info = NodeInfo {
            app_name: Some(display_name.clone()),
        };

        state.nodes.insert(id, node_info);

        // Check if we should auto-route this app
        if state.config.routing.enable_auto_routing {
            // TODO: Implement actual routing
            let target_sink = state.config.routing.default_sink.clone();
            info!("Would route {} to {}", display_name, target_sink);
        }

        // Update cache
        let app_info = AppInfo {
            display_name: display_name.clone(),
            binary_name: binary_name.unwrap_or_default(),
            current_sink: "Unknown".to_string(), // Will be updated
            active: true,
            sink_input_ids: vec![id],
        };

        // Send update through channel
        let _ = state.cache_tx.send(CacheUpdate::UpdateApp(display_name, app_info));
    }
}

fn handle_global_remove(state: &Rc<RefCell<MonitorState>>, id: u32) {
    let mut state = state.borrow_mut();

    if let Some(node_info) = state.nodes.remove(&id) {
        if let Some(app_name) = node_info.app_name {
            let app_name_for_log = app_name.clone();
            // Mark app as inactive in cache
            let _ = state.cache_tx.send(CacheUpdate::MarkAppInactive(app_name.clone(), id));

            info!("Audio stream removed: {} (id: {})", app_name_for_log, id);
        }
    }
}
