use anyhow::Result;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, error, info};
use zbus::{dbus_interface, Connection, SignalContext};

use crate::cache::AudioCache;
use crate::config::AppMappings;
use crate::pipewire_controller::PipeWireController;

/// D-Bus service for the PipeWire Volume Mixer
pub struct DBusService {
    cache: Arc<RwLock<AudioCache>>,
    controller: Arc<PipeWireController>,
    generation: Arc<RwLock<u32>>,
    app_mappings: Arc<RwLock<AppMappings>>,
}

impl DBusService {
    pub fn new(
        cache: Arc<RwLock<AudioCache>>,
        controller: Arc<PipeWireController>,
        app_mappings: Arc<RwLock<AppMappings>>,
    ) -> Self {
        Self { cache, controller, generation: Arc::new(RwLock::new(0)), app_mappings }
    }

    /// Convert sinks to D-Bus HashMap
    async fn sinks_to_hashmap(
        &self,
    ) -> Result<HashMap<String, HashMap<String, zbus::zvariant::Value<'static>>>> {
        let cache = self.cache.read().await;
        let mut map = HashMap::new();

        for entry in cache.sinks.iter() {
            let (name, sink) = entry.pair();
            let mut sink_map = HashMap::new();
            sink_map
                .insert("pipewire_id".to_string(), zbus::zvariant::Value::U32(sink.pipewire_id));
            sink_map.insert("volume".to_string(), zbus::zvariant::Value::F64(sink.volume as f64));
            sink_map.insert("muted".to_string(), zbus::zvariant::Value::Bool(sink.muted));

            map.insert(name.clone(), sink_map);
        }

        Ok(map)
    }

    /// Convert applications to D-Bus HashMap
    async fn apps_to_hashmap(
        &self,
    ) -> Result<HashMap<String, HashMap<String, zbus::zvariant::Value<'static>>>> {
        let cache = self.cache.read().await;
        let mut map = HashMap::new();

        for entry in cache.apps.iter() {
            let (name, app) = entry.pair();
            let mut app_map = HashMap::new();
            app_map.insert(
                "display_name".to_string(),
                zbus::zvariant::Value::Str(app.display_name.clone().into()),
            );
            app_map.insert(
                "current_sink".to_string(),
                zbus::zvariant::Value::Str(app.current_sink.clone().into()),
            );
            app_map.insert("pipewire_id".to_string(), zbus::zvariant::Value::U32(app.pipewire_id));
            app_map.insert("active".to_string(), zbus::zvariant::Value::Bool(app.active));

            map.insert(name.clone(), app_map);
        }

        Ok(map)
    }

    /// Increment generation counter
    async fn increment_generation(&self) -> u32 {
        let mut gen = self.generation.write().await;
        *gen += 1;
        *gen
    }

    /// Get current timestamp
    fn get_timestamp() -> u32 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as u32
    }
}

#[dbus_interface(name = "org.gnome.PipewireVolumeMixer")]
impl DBusService {
    /// Get all sinks
    #[dbus_interface(property)]
    async fn sinks(&self) -> HashMap<String, HashMap<String, zbus::zvariant::Value<'static>>> {
        self.sinks_to_hashmap().await.unwrap_or_else(|e| {
            error!("Failed to convert sinks: {}", e);
            HashMap::new()
        })
    }

    /// Get all applications
    #[dbus_interface(property)]
    async fn applications(
        &self,
    ) -> HashMap<String, HashMap<String, zbus::zvariant::Value<'static>>> {
        self.apps_to_hashmap().await.unwrap_or_else(|e| {
            error!("Failed to convert apps: {}", e);
            HashMap::new()
        })
    }

    /// Get generation counter
    #[dbus_interface(property)]
    async fn generation(&self) -> u32 {
        *self.generation.read().await
    }

    /// Get last update timestamp
    #[dbus_interface(property)]
    async fn last_update(&self) -> u32 {
        Self::get_timestamp()
    }

    /// Set sink volume
    async fn set_sink_volume(&self, sink_name: String, volume: f64) -> bool {
        debug!("D-Bus: Setting volume for sink {} to {}", sink_name, volume);

        // Update cache optimistically
        {
            let cache = self.cache.write().await;
            if let Some(mut sink) = cache.sinks.get_mut(&sink_name) {
                sink.volume = volume as f32;
            };
        }

        // Apply to PipeWire
        if let Err(e) = self.controller.set_sink_volume(&sink_name, volume as f32).await {
            error!("Failed to set sink volume: {}", e);
            return false;
        }

        true
    }

    /// Set sink mute state
    async fn set_sink_mute(&self, sink_name: String, muted: bool) -> bool {
        debug!("D-Bus: Setting mute for sink {} to {}", sink_name, muted);

        // Update cache optimistically
        {
            let cache = self.cache.write().await;
            if let Some(mut sink) = cache.sinks.get_mut(&sink_name) {
                sink.muted = muted;
            };
        }

        // Apply to PipeWire
        if let Err(e) = self.controller.set_sink_mute(&sink_name, muted).await {
            error!("Failed to set sink mute: {}", e);
            return false;
        }

        true
    }

    /// Route application to a sink
    async fn route_application(
        &self,
        #[zbus(signal_context)] ctx: SignalContext<'_>,
        app_name: String,
        sink_name: String,
    ) -> bool {
        debug!("D-Bus: Routing app {} to sink {}", app_name, sink_name);

        // Apply to PipeWire first
        if let Err(e) = self.controller.route_app(&app_name, &sink_name).await {
            error!("Failed to route application: {}", e);
            return false;
        }

        // Controller already updated the cache with the actual result

        // Save mapping to disk for persistence
        {
            let mut mappings = self.app_mappings.write().await;
            if let Err(e) = mappings.update_and_save(app_name.clone(), sink_name.clone()) {
                error!("Failed to save app mapping to disk: {}", e);
                // Don't fail the routing operation if save fails
            } else {
                debug!("Saved mapping {} -> {} to disk", app_name, sink_name);
            }
        }

        // Emit the ApplicationRouted signal
        if let Err(e) = Self::application_routed(&ctx, &app_name, &sink_name).await {
            error!("Failed to emit ApplicationRouted signal: {}", e);
        }

        // Emit property changed signal for Applications
        let new_gen = self.increment_generation().await;
        if let Err(e) = Self::state_changed(&ctx, new_gen).await {
            error!("Failed to emit StateChanged signal: {}", e);
        }

        // Wait a bit and refresh to ensure cache is in sync with PipeWire
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        self.refresh_state().await;

        true
    }

    /// Force refresh of state
    async fn refresh_state(&self) {
        debug!("D-Bus: Refreshing state");
        let _ = self.increment_generation().await;
    }

    /// Get full state as a single HashMap
    async fn get_full_state(&self) -> HashMap<String, zbus::zvariant::Value<'static>> {
        let mut state = HashMap::new();

        state.insert("sinks".to_string(), zbus::zvariant::Value::from(self.sinks().await));
        state.insert(
            "applications".to_string(),
            zbus::zvariant::Value::from(self.applications().await),
        );
        state.insert("generation".to_string(), zbus::zvariant::Value::U32(self.generation().await));
        state.insert(
            "last_update".to_string(),
            zbus::zvariant::Value::U32(self.last_update().await),
        );

        state
    }

    /// Signal: State changed
    #[dbus_interface(signal)]
    async fn state_changed(ctx: &SignalContext<'_>, generation: u32) -> zbus::Result<()>;

    /// Signal: Sink volume changed
    #[dbus_interface(signal)]
    async fn sink_volume_changed(
        ctx: &SignalContext<'_>,
        sink_name: &str,
        volume: f64,
    ) -> zbus::Result<()>;

    /// Signal: Sink mute changed
    #[dbus_interface(signal)]
    async fn sink_mute_changed(
        ctx: &SignalContext<'_>,
        sink_name: &str,
        muted: bool,
    ) -> zbus::Result<()>;

    /// Signal: Application routed
    #[dbus_interface(signal)]
    async fn application_routed(
        ctx: &SignalContext<'_>,
        app_name: &str,
        sink_name: &str,
    ) -> zbus::Result<()>;

    /// Signal: Applications changed
    #[dbus_interface(signal)]
    async fn apps_changed(
        ctx: &SignalContext<'_>,
        added: Vec<String>,
        removed: Vec<String>,
    ) -> zbus::Result<()>;
}

/// Start the D-Bus service
pub async fn start_dbus_service(
    cache: Arc<RwLock<AudioCache>>,
    controller: Arc<PipeWireController>,
    app_mappings: Arc<RwLock<AppMappings>>,
) -> Result<Connection> {
    info!("Starting D-Bus service");

    let service = DBusService::new(cache, controller, app_mappings);

    let connection = Connection::session().await?;

    // Register the service
    connection.object_server().at("/org/gnome/PipewireVolumeMixer", service).await?;

    // Request the bus name
    connection.request_name("org.gnome.PipewireVolumeMixer").await?;

    info!("D-Bus service started successfully");

    Ok(connection)
}

/// Helper to emit state change signals
#[allow(dead_code)]
pub async fn emit_state_changed(connection: &Connection, generation: u32) -> Result<()> {
    let ctx = SignalContext::new(connection, "/org/gnome/PipewireVolumeMixer")?;
    DBusService::state_changed(&ctx, generation).await?;
    Ok(())
}

/// Helper to emit sink volume changed signal
#[allow(dead_code)]
pub async fn emit_sink_volume_changed(
    connection: &Connection,
    sink_name: &str,
    volume: f64,
) -> Result<()> {
    let ctx = SignalContext::new(connection, "/org/gnome/PipewireVolumeMixer")?;
    DBusService::sink_volume_changed(&ctx, sink_name, volume).await?;
    Ok(())
}

/// Helper to emit sink mute changed signal
#[allow(dead_code)]
pub async fn emit_sink_mute_changed(
    connection: &Connection,
    sink_name: &str,
    muted: bool,
) -> Result<()> {
    let ctx = SignalContext::new(connection, "/org/gnome/PipewireVolumeMixer")?;
    DBusService::sink_mute_changed(&ctx, sink_name, muted).await?;
    Ok(())
}

/// Helper to emit application routed signal
#[allow(dead_code)]
pub async fn emit_application_routed(
    connection: &Connection,
    app_name: &str,
    sink_name: &str,
) -> Result<()> {
    let ctx = SignalContext::new(connection, "/org/gnome/PipewireVolumeMixer")?;
    DBusService::application_routed(&ctx, app_name, sink_name).await?;
    Ok(())
}

/// Helper to emit applications changed signal
#[allow(dead_code)]
pub async fn emit_applications_changed(
    connection: &Connection,
    added: Vec<String>,
    removed: Vec<String>,
) -> Result<()> {
    let ctx = SignalContext::new(connection, "/org/gnome/PipewireVolumeMixer")?;
    DBusService::apps_changed(&ctx, added, removed).await?;
    Ok(())
}
