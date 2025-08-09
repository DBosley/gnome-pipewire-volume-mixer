use anyhow::{Context, Result};
use memmap2::{MmapMut, MmapOptions};
use nix::unistd::Uid;
use std::fs::OpenOptions;
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tokio::sync::RwLock;
use tokio::time;
use tracing::{debug, error, info, warn};

use crate::cache::{AudioCache, CacheSnapshot};

const SHM_SIZE: usize = 64 * 1024; // 64KB
const STALE_THRESHOLD_SECS: u64 = 30; // Consider memory stale after 30 seconds

pub struct SharedMemoryWriter {
    cache: Arc<RwLock<AudioCache>>,
    mmap: MmapMut,
    path: String,
    last_successful_write: SystemTime,
}

impl SharedMemoryWriter {
    pub fn new(cache: Arc<RwLock<AudioCache>>) -> Result<Self> {
        let uid = Uid::current();
        let path = format!("/dev/shm/pipewire-volume-mixer-{uid}");

        let mmap = Self::create_shared_memory(&path)?;

        Ok(Self { cache, mmap, path, last_successful_write: SystemTime::now() })
    }

    fn create_shared_memory(path: &str) -> Result<MmapMut> {
        // Create or open the shared memory file
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(path)
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

        Ok(mmap)
    }

    fn recreate_shared_memory(&mut self) -> Result<()> {
        warn!("Recreating shared memory due to staleness or error");

        // Try to unmap the old memory first
        drop(std::mem::replace(
            &mut self.mmap,
            MmapMut::map_anon(1)?, // Create tiny anonymous map as placeholder
        ));

        // Remove the old file if it exists
        let _ = std::fs::remove_file(&self.path);

        // Create new shared memory
        self.mmap = Self::create_shared_memory(&self.path)?;
        self.last_successful_write = SystemTime::now();

        info!("Successfully recreated shared memory at {}", self.path);
        Ok(())
    }

    pub async fn run(mut self) {
        // Use adaptive update rate: fast when active, slow when idle
        let fast_interval = Duration::from_millis(50);
        let slow_interval = Duration::from_millis(200);
        let mut interval = time::interval(fast_interval);
        let mut last_generation = 0u64;
        let mut idle_cycles = 0;
        let mut consecutive_failures = 0;

        loop {
            interval.tick().await;

            // Check if shared memory is stale
            if let Ok(elapsed) = self.last_successful_write.elapsed() {
                if elapsed.as_secs() > STALE_THRESHOLD_SECS {
                    warn!(
                        "Shared memory hasn't been updated for {} seconds, recreating",
                        elapsed.as_secs()
                    );
                    if let Err(e) = self.recreate_shared_memory() {
                        error!("Failed to recreate shared memory: {}", e);
                    } else {
                        // Force a write after recreation
                        last_generation = 0;
                    }
                }
            }

            let current_generation = {
                let cache = self.cache.read().await;
                cache.get_generation()
            };

            // Only update if generation changed or we need to force an update
            if current_generation != last_generation || consecutive_failures > 3 {
                // Get a snapshot of the cache
                let snapshot = {
                    let cache = self.cache.read().await;
                    cache.get_snapshot()
                };

                if let Err(e) = self.write_snapshot(&snapshot) {
                    error!("Failed to write cache to shared memory: {}", e);
                    consecutive_failures += 1;

                    // Try to recreate shared memory after multiple failures
                    if consecutive_failures > 3 {
                        warn!("Multiple write failures, attempting to recreate shared memory");
                        if let Err(e) = self.recreate_shared_memory() {
                            error!("Failed to recreate shared memory: {}", e);
                        } else {
                            consecutive_failures = 0;
                        }
                    }
                } else {
                    last_generation = current_generation;
                    self.last_successful_write = SystemTime::now();
                    consecutive_failures = 0;
                    debug!("Updated shared memory cache (generation {})", current_generation);

                    // Reset to fast interval when activity detected
                    if idle_cycles > 0 {
                        interval = time::interval(fast_interval);
                        idle_cycles = 0;
                    }
                }
            } else {
                // No changes, increment idle counter
                idle_cycles += 1;

                // After 10 idle cycles (~500ms), switch to slow interval
                if idle_cycles == 10 {
                    interval = time::interval(slow_interval);
                    debug!("Switching to slow update interval");
                }

                // Periodically write even without changes to keep memory fresh
                if idle_cycles > 0 && idle_cycles % 100 == 0 {
                    // Every ~20 seconds on slow interval
                    let snapshot = {
                        let cache = self.cache.read().await;
                        cache.get_snapshot()
                    };

                    if let Err(e) = self.write_snapshot(&snapshot) {
                        error!("Failed to write periodic update: {}", e);
                    } else {
                        self.last_successful_write = SystemTime::now();
                        debug!("Wrote periodic update to keep shared memory fresh");
                    }
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

        // Update file modification time to reflect the write
        // This is important for staleness detection
        if let Ok(_metadata) = std::fs::metadata(&self.path) {
            let _ = filetime::set_file_mtime(&self.path, filetime::FileTime::now());
        }

        Ok(())
    }
}
