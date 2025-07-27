use anyhow::{Context, Result};
use memmap2::{MmapMut, MmapOptions};
use nix::unistd::Uid;
use std::fs::OpenOptions;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use tokio::time;
use tracing::{debug, error};

use crate::cache::{AudioCache, CacheSnapshot};

const SHM_SIZE: usize = 64 * 1024; // 64KB

pub struct SharedMemoryWriter {
    cache: Arc<RwLock<AudioCache>>,
    mmap: MmapMut,
}

impl SharedMemoryWriter {
    pub fn new(cache: Arc<RwLock<AudioCache>>) -> Result<Self> {
        let uid = Uid::current();
        let path = format!("/dev/shm/pipewire-volume-mixer-{uid}");

        // Create or open the shared memory file
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(&path)
            .context("Failed to open shared memory file")?;

        // Set the file size
        file.set_len(SHM_SIZE as u64)?;

        // Memory map the file
        let mmap = unsafe {
            MmapOptions::new()
                .len(SHM_SIZE)
                .map_mut(&file)
                .context("Failed to mmap shared memory")?
        };

        Ok(Self { cache, mmap })
    }

    pub async fn run(mut self) {
        let mut interval = time::interval(Duration::from_millis(100));
        let mut last_generation = 0u64;

        loop {
            interval.tick().await;

            let current_generation = {
                let cache = self.cache.read().await;
                cache.get_generation()
            };

            // Only update if generation changed
            if current_generation != last_generation {
                // Get a snapshot of the cache
                let snapshot = {
                    let cache = self.cache.read().await;
                    cache.get_snapshot()
                };

                if let Err(e) = self.write_snapshot(&snapshot) {
                    error!("Failed to write cache to shared memory: {}", e);
                } else {
                    last_generation = current_generation;
                    debug!("Updated shared memory cache (generation {})", current_generation);
                }
            }
        }
    }

    fn write_snapshot(&mut self, snapshot: &CacheSnapshot) -> Result<()> {
        let mut offset = 0;
        let data = &mut self.mmap[..];

        // Write header
        // Version (4 bytes)
        data[offset..offset + 4].copy_from_slice(&1u32.to_le_bytes());
        offset += 4;

        // Generation (8 bytes)
        data[offset..offset + 8].copy_from_slice(&snapshot.generation.to_le_bytes());
        offset += 8;

        // Timestamp (8 bytes)
        let timestamp =
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()
                as u64;
        data[offset..offset + 8].copy_from_slice(&timestamp.to_le_bytes());
        offset += 8;

        // Reserved (12 bytes)
        offset += 12;

        // Write sinks
        data[offset..offset + 4].copy_from_slice(&(snapshot.sinks.len() as u32).to_le_bytes());
        offset += 4;

        for (name, sink) in &snapshot.sinks {
            let name_bytes = name.as_bytes();
            data[offset] = name_bytes.len() as u8;
            offset += 1;

            data[offset..offset + name_bytes.len()].copy_from_slice(name_bytes);
            offset += name_bytes.len();

            data[offset..offset + 4].copy_from_slice(&sink.id.to_le_bytes());
            offset += 4;

            data[offset..offset + 4].copy_from_slice(&sink.volume.to_le_bytes());
            offset += 4;

            data[offset] = if sink.muted { 1 } else { 0 };
            offset += 1;
        }

        // Write apps
        data[offset..offset + 4].copy_from_slice(&(snapshot.apps.len() as u32).to_le_bytes());
        offset += 4;

        for (name, app) in &snapshot.apps {
            // App name
            let name_bytes = name.as_bytes();
            data[offset] = name_bytes.len() as u8;
            offset += 1;

            data[offset..offset + name_bytes.len()].copy_from_slice(name_bytes);
            offset += name_bytes.len();

            // Current sink
            let sink_bytes = app.current_sink.as_bytes();
            data[offset] = sink_bytes.len() as u8;
            offset += 1;

            data[offset..offset + sink_bytes.len()].copy_from_slice(sink_bytes);
            offset += sink_bytes.len();

            // Active flag
            data[offset] = if app.active { 1 } else { 0 };
            offset += 1;
        }

        // Ensure changes are written
        self.mmap.flush()?;

        Ok(())
    }
}
