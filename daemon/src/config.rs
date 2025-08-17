use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use tracing::{debug, info};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub cache: CacheConfig,
    pub routing: RoutingConfig,
    pub performance: PerformanceConfig,
    pub virtual_sinks: Vec<VirtualSink>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheConfig {
    pub update_interval_ms: u64,
    pub max_remembered_apps: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutingConfig {
    pub enable_auto_routing: bool,
    pub default_sink: String,
    pub rules: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PerformanceConfig {
    pub event_debounce_ms: u64,
    pub max_events_per_second: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VirtualSink {
    pub name: String,
    pub display_name: String,
    pub icon: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            cache: CacheConfig { update_interval_ms: 100, max_remembered_apps: 50 },
            routing: RoutingConfig {
                enable_auto_routing: true,
                default_sink: "Game".to_string(),
                rules: HashMap::new(),
            },
            performance: PerformanceConfig { event_debounce_ms: 50, max_events_per_second: 100 },
            virtual_sinks: vec![
                VirtualSink {
                    name: "Game".to_string(),
                    display_name: "Game".to_string(),
                    icon: "applications-games-symbolic".to_string(),
                },
                VirtualSink {
                    name: "Chat".to_string(),
                    display_name: "Chat".to_string(),
                    icon: "user-available-symbolic".to_string(),
                },
                VirtualSink {
                    name: "Media".to_string(),
                    display_name: "Media".to_string(),
                    icon: "applications-multimedia-symbolic".to_string(),
                },
            ],
        }
    }
}

impl Config {
    pub fn load<P: AsRef<Path>>(path: P) -> Result<Self> {
        if path.as_ref().exists() {
            let contents = fs::read_to_string(path)?;
            let config: Config = toml::from_str(&contents)?;
            Ok(config)
        } else {
            Ok(Self::default())
        }
    }
}

/// Structure for persisting app-to-sink mappings
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppMappings {
    #[serde(default)]
    pub mappings: HashMap<String, String>,
    #[serde(default)]
    pub version: u32,
}

impl AppMappings {
    /// Get the default config directory path
    pub fn config_dir() -> Result<PathBuf> {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USER").map(|user| format!("/home/{user}")))
            .unwrap_or_else(|_| "/tmp".to_string());

        let config_dir = PathBuf::from(home).join(".config").join("pipewire-volume-mixer");
        Ok(config_dir)
    }

    /// Get the default config file path
    pub fn config_file() -> Result<PathBuf> {
        Ok(Self::config_dir()?.join("app-mappings.toml"))
    }

    /// Load app mappings from disk
    pub fn load() -> Result<Self> {
        let config_file = Self::config_file()?;

        if config_file.exists() {
            let contents = fs::read_to_string(&config_file)?;
            let mappings: AppMappings = toml::from_str(&contents)?;
            info!("Loaded {} app mappings from {:?}", mappings.mappings.len(), config_file);
            Ok(mappings)
        } else {
            info!("No existing app mappings file at {:?}, using defaults", config_file);
            Ok(Self::default())
        }
    }

    /// Save app mappings to disk
    pub fn save(&self) -> Result<()> {
        let config_dir = Self::config_dir()?;
        let config_file = Self::config_file()?;

        // Create config directory if it doesn't exist
        if !config_dir.exists() {
            fs::create_dir_all(&config_dir)?;
            info!("Created config directory: {:?}", config_dir);
        }

        // Serialize to TOML
        let contents = toml::to_string_pretty(self)?;

        // Write to file
        fs::write(&config_file, contents)?;
        info!("Saved {} app mappings to {:?}", self.mappings.len(), config_file);

        Ok(())
    }

    /// Update a mapping and save to disk
    pub fn update_and_save(&mut self, app_name: String, sink_name: String) -> Result<()> {
        self.mappings.insert(app_name.clone(), sink_name.clone());
        self.version += 1;
        self.save()?;
        debug!("Updated mapping: {} -> {}", app_name, sink_name);
        Ok(())
    }

    /// Get a mapping for an app
    #[allow(dead_code)]
    pub fn get(&self, app_name: &str) -> Option<&String> {
        self.mappings.get(app_name)
    }

    /// Remove old mappings to prevent unbounded growth
    #[allow(dead_code)]
    pub fn cleanup(&mut self, max_entries: usize) {
        if self.mappings.len() > max_entries {
            // Keep only the most recent entries
            // In a real implementation, we'd track last-used times
            let to_remove = self.mappings.len() - max_entries;
            let keys_to_remove: Vec<String> =
                self.mappings.keys().take(to_remove).cloned().collect();

            for key in keys_to_remove {
                self.mappings.remove(&key);
            }

            info!("Cleaned up app mappings, kept {} entries", max_entries);
        }
    }
}
