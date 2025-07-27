use pipewire_volume_mixer_daemon::cache::{AudioCache, SinkInfo};
use pipewire_volume_mixer_daemon::shared_memory::SharedMemoryWriter;
use std::sync::Arc;
use tokio::sync::RwLock;

#[tokio::test]
async fn test_shared_memory_creation() {
    let cache = Arc::new(RwLock::new(AudioCache::new()));
    let writer = SharedMemoryWriter::new(cache.clone());
    assert!(writer.is_ok());

    // Add some test data
    {
        let cache_write = cache.write().await;
        cache_write.update_sink(
            "Game".to_string(),
            SinkInfo { id: 34, name: "Game".to_string(), volume: 1.0, muted: false },
        );
    }
}

#[test]
fn test_binary_format() {
    // Test the binary format encoding/decoding
    let test_string = "Hello, World!";
    let mut buffer = Vec::new();

    // Write length (4 bytes)
    buffer.extend_from_slice(&(test_string.len() as u32).to_le_bytes());
    // Write string
    buffer.extend_from_slice(test_string.as_bytes());

    // Read it back
    let len = u32::from_le_bytes([buffer[0], buffer[1], buffer[2], buffer[3]]) as usize;
    let string = String::from_utf8(buffer[4..4 + len].to_vec()).unwrap();

    assert_eq!(string, test_string);
}
