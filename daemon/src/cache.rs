use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SinkInfo {
    pub id: u32,
    pub name: String,
    pub volume: f32,
    pub muted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppInfo {
    pub display_name: String,
    pub binary_name: String,
    pub current_sink: String,
    pub active: bool,
    pub sink_input_ids: Vec<u32>,
    #[serde(skip)]
    #[allow(dead_code)] // Used for TTL tracking but not directly read
    pub inactive_since: Option<std::time::Instant>,
}

#[derive(Debug)]
pub struct AudioCache {
    generation: AtomicU64,
    pub sinks: DashMap<String, SinkInfo>,
    pub apps: DashMap<String, AppInfo>,
    pub routing_rules: DashMap<String, String>,
    pub remembered_apps: DashMap<String, String>, // app -> last sink
}

impl Default for AudioCache {
    fn default() -> Self {
        Self::new()
    }
}

impl AudioCache {
    pub fn new() -> Self {
        Self {
            generation: AtomicU64::new(0),
            sinks: DashMap::new(),
            apps: DashMap::new(),
            routing_rules: DashMap::new(),
            remembered_apps: DashMap::new(),
        }
    }

    pub fn increment_generation(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    pub fn get_generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    pub fn update_sink(&self, name: String, info: SinkInfo) {
        self.sinks.insert(name, info);
        self.increment_generation();
    }

    pub fn update_app(&self, name: String, info: AppInfo) {
        // Remember the app's sink assignment
        if info.active {
            self.remembered_apps.insert(name.clone(), info.current_sink.clone());
        }

        self.apps.insert(name, info);
        self.increment_generation();
    }

    pub fn get_snapshot(&self) -> CacheSnapshot {
        CacheSnapshot {
            generation: self.get_generation(),
            sinks: self.sinks.iter().map(|r| (r.key().clone(), r.value().clone())).collect(),
            apps: self.apps.iter().map(|r| (r.key().clone(), r.value().clone())).collect(),
        }
    }

    #[allow(dead_code)] // Used by cleanup task in main.rs
    pub fn cleanup_inactive_apps(&self, ttl_seconds: u64) -> usize {
        let now = std::time::Instant::now();
        let ttl = std::time::Duration::from_secs(ttl_seconds);
        let mut removed_count = 0;

        // Use retain to remove items in-place (more efficient than collect + remove)
        self.apps.retain(|name, app| {
            // Keep active apps
            if app.active {
                return true;
            }

            // Keep apps with routing rules
            if self.routing_rules.contains_key(name) {
                return true;
            }

            // Check if inactive app has expired
            if let Some(inactive_since) = app.inactive_since {
                if now.duration_since(inactive_since) > ttl {
                    // Remove from remembered apps too
                    self.remembered_apps.remove(name);
                    removed_count += 1;
                    return false; // Remove this app
                }
            }

            true // Keep this app
        });

        if removed_count > 0 {
            self.increment_generation();
        }

        removed_count
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheSnapshot {
    pub generation: u64,
    pub sinks: HashMap<String, SinkInfo>,
    pub apps: HashMap<String, AppInfo>,
}
