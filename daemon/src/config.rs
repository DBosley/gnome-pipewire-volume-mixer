use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

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
