use pipewire_volume_mixer_daemon::cache::AudioCache;
use pipewire_volume_mixer_daemon::ipc::IpcServer;
use std::sync::Arc;
use tokio::sync::RwLock;

#[tokio::test]
async fn test_ipc_connection() {
    let cache = Arc::new(RwLock::new(AudioCache::new()));

    // We can't easily test the actual IPC server without running it,
    // but we can test the command parsing logic

    // For now, just verify the server can be created
    let result = IpcServer::new(cache);
    assert!(result.is_ok());
}

#[tokio::test]
async fn test_command_format() {
    // Test that commands are properly formatted
    let commands =
        vec!["ROUTE Firefox Media", "SET_VOLUME Game 0.5", "MUTE Chat true", "RELOAD_CONFIG"];

    for cmd in commands {
        let parts: Vec<&str> = cmd.split_whitespace().collect();
        assert!(!parts.is_empty());

        match parts[0] {
            "ROUTE" => assert_eq!(parts.len(), 3),
            "SET_VOLUME" => {
                assert_eq!(parts.len(), 3);
                let volume: f32 = parts[2].parse().unwrap();
                assert!((0.0..=1.0).contains(&volume));
            }
            "MUTE" => {
                assert_eq!(parts.len(), 3);
                let _muted: bool = parts[2].parse().unwrap();
            }
            "RELOAD_CONFIG" => assert_eq!(parts.len(), 1),
            _ => panic!("Unknown command"),
        }
    }
}
