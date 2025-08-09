use std::process::Command;
use tracing::debug;

/// Trait for executing system commands - allows for mocking in tests
pub trait CommandExecutor: Send + Sync {
    fn execute(&self, program: &str, args: &[&str]) -> std::io::Result<std::process::Output>;
    fn execute_shell(&self, cmd: &str) -> std::io::Result<std::process::Output>;
}

/// Real command executor for production
pub struct SystemCommandExecutor;

impl CommandExecutor for SystemCommandExecutor {
    fn execute(&self, program: &str, args: &[&str]) -> std::io::Result<std::process::Output> {
        Command::new(program).args(args).output()
    }

    fn execute_shell(&self, cmd: &str) -> std::io::Result<std::process::Output> {
        Command::new("sh").arg("-c").arg(cmd).output()
    }
}

/// Configuration for app name detection
pub struct AppNameConfig {
    /// Window titles to ignore (system/generic windows)
    pub ignored_window_titles: Vec<String>,
    /// Maximum number of parent processes to check
    pub max_parent_depth: usize,
    /// Prefixes that indicate we should use application.name instead
    pub fallback_prefixes: Vec<String>,
}

impl Default for AppNameConfig {
    fn default() -> Self {
        Self {
            ignored_window_titles: vec![
                "XdndCollectionWindowImp".to_string(),
                "Wine System Tray".to_string(),
                "Default IME".to_string(),
            ],
            max_parent_depth: 3,
            fallback_prefixes: vec!["steam_app".to_string()],
        }
    }
}

/// App name detector with configurable behavior
pub struct AppNameDetector {
    executor: Box<dyn CommandExecutor>,
    config: AppNameConfig,
}

impl AppNameDetector {
    pub fn new(executor: Box<dyn CommandExecutor>, config: AppNameConfig) -> Self {
        Self { executor, config }
    }

    pub fn new_system() -> Self {
        Self::new(Box::new(SystemCommandExecutor), AppNameConfig::default())
    }

    /// Extract binary name from a full path
    pub fn extract_binary_name(&self, path: &str) -> String {
        // Handle both Unix and Windows paths
        let name =
            path.split('/').next_back().unwrap_or(path).split('\\').next_back().unwrap_or(path);

        name.trim_end_matches("-bin").trim_end_matches(".exe").to_string()
    }

    /// Get parent PID for a given PID
    pub fn get_parent_pid(&self, pid: u32) -> Option<u32> {
        let output = self.executor.execute("ps", &["-o", "ppid=", "-p", &pid.to_string()]).ok()?;

        if !output.status.success() {
            return None;
        }

        let ppid_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
        ppid_str.parse::<u32>().ok().filter(|&p| p > 1)
    }

    /// Get window title for a PID using xdotool
    pub fn get_window_title(&self, pid: u32) -> Option<String> {
        let cmd = format!(
            "xdotool search --pid {pid} 2>/dev/null | head -1 | xargs -r xdotool getwindowname 2>/dev/null"
        );

        let output = self.executor.execute_shell(&cmd).ok()?;

        if !output.status.success() {
            return None;
        }

        let title = String::from_utf8_lossy(&output.stdout).trim().to_string();

        // Check if title is valid (not empty and not in ignored list)
        if !title.is_empty() && !self.config.ignored_window_titles.contains(&title) {
            Some(title)
        } else {
            None
        }
    }

    /// Check if a window title should trigger fallback to application.name
    pub fn should_use_fallback(&self, title: &str) -> bool {
        self.config.fallback_prefixes.iter().any(|prefix| title.starts_with(prefix))
    }

    /// Walk up the process tree to find a window title
    pub fn find_window_title_in_tree(&self, starting_pid: u32) -> Option<String> {
        let mut current_pid = starting_pid;

        for _ in 0..self.config.max_parent_depth {
            if let Some(title) = self.get_window_title(current_pid) {
                // Check if this is a Steam app that we should skip
                if self.should_use_fallback(&title) {
                    debug!("Found Steam window '{}', will use application.name instead", title);
                    return None; // Signal to use application.name
                }
                debug!("Found window title for PID {}: {}", current_pid, title);
                return Some(title);
            }

            // Try parent process
            match self.get_parent_pid(current_pid) {
                Some(ppid) => {
                    debug!("Checking parent PID {} for window title", ppid);
                    current_pid = ppid;
                }
                None => break,
            }
        }

        None
    }

    /// Determine the best display name for an app
    pub fn determine_display_name(
        &self,
        application_name: &str,
        binary_path: Option<&str>,
        pid: Option<u32>,
    ) -> String {
        // Priority 1: Window title from X11/Wayland (if we have a PID)
        if let Some(pid) = pid {
            if let Some(window_title) = self.find_window_title_in_tree(pid) {
                return window_title;
            }
        }

        // Priority 2: Application name if it's not generic
        if !application_name.is_empty() && !is_generic_app_name(application_name) {
            return application_name.to_string();
        }

        // Priority 3: Binary name as fallback
        if let Some(path) = binary_path {
            let binary_name = self.extract_binary_name(path);
            if !binary_name.is_empty() {
                return capitalize_first_letter(&binary_name);
            }
        }

        // Last resort: use application name as-is
        application_name.to_string()
    }
}

/// Check if an application name is generic/unhelpful
fn is_generic_app_name(name: &str) -> bool {
    name.contains("WEBRTC")
        || name.contains("WebRTC")
        || name.contains("wine")
        || name.contains("preloader")
        || name == "wine64-preloader"
        || name == "wine-preloader"
}

/// Capitalize the first letter of a string
fn capitalize_first_letter(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        None => String::new(),
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::os::unix::process::ExitStatusExt;

    /// Mock command executor for testing
    struct MockCommandExecutor {
        ps_responses: HashMap<u32, u32>,     // PID -> Parent PID
        window_titles: HashMap<u32, String>, // PID -> Window Title
    }

    impl MockCommandExecutor {
        fn new() -> Self {
            Self { ps_responses: HashMap::new(), window_titles: HashMap::new() }
        }

        fn with_parent(mut self, pid: u32, ppid: u32) -> Self {
            self.ps_responses.insert(pid, ppid);
            self
        }

        fn with_window(mut self, pid: u32, title: String) -> Self {
            self.window_titles.insert(pid, title);
            self
        }
    }

    impl CommandExecutor for MockCommandExecutor {
        fn execute(&self, program: &str, args: &[&str]) -> std::io::Result<std::process::Output> {
            if program == "ps" && args.len() >= 3 && args[0] == "-o" && args[1] == "ppid=" {
                if let Ok(pid) = args[3].parse::<u32>() {
                    if let Some(ppid) = self.ps_responses.get(&pid) {
                        return Ok(std::process::Output {
                            status: std::process::ExitStatus::from_raw(0),
                            stdout: format!("{ppid}\n").into_bytes(),
                            stderr: Vec::new(),
                        });
                    }
                }
            }

            Ok(std::process::Output {
                status: std::process::ExitStatus::from_raw(1),
                stdout: Vec::new(),
                stderr: Vec::new(),
            })
        }

        fn execute_shell(&self, cmd: &str) -> std::io::Result<std::process::Output> {
            // Parse xdotool command to extract PID
            if cmd.contains("xdotool search --pid") {
                let pid_str =
                    cmd.split("--pid ").nth(1).and_then(|s| s.split(' ').next()).unwrap_or("");

                if let Ok(pid) = pid_str.parse::<u32>() {
                    if let Some(title) = self.window_titles.get(&pid) {
                        return Ok(std::process::Output {
                            status: std::process::ExitStatus::from_raw(0),
                            stdout: title.as_bytes().to_vec(),
                            stderr: Vec::new(),
                        });
                    }
                }
            }

            Ok(std::process::Output {
                status: std::process::ExitStatus::from_raw(1),
                stdout: Vec::new(),
                stderr: Vec::new(),
            })
        }
    }

    #[test]
    fn test_extract_binary_name() {
        let detector = AppNameDetector::new_system();

        assert_eq!(detector.extract_binary_name("/usr/bin/firefox"), "firefox");
        assert_eq!(detector.extract_binary_name("/opt/discord/Discord"), "Discord");
        assert_eq!(detector.extract_binary_name("wine64-preloader"), "wine64-preloader");
        assert_eq!(detector.extract_binary_name("/usr/bin/firefox-bin"), "firefox");
        assert_eq!(detector.extract_binary_name("C:\\Program Files\\App.exe"), "App");
    }

    #[test]
    fn test_get_parent_pid() {
        let executor = MockCommandExecutor::new().with_parent(1234, 5678).with_parent(5678, 1);

        let detector = AppNameDetector::new(Box::new(executor), AppNameConfig::default());

        assert_eq!(detector.get_parent_pid(1234), Some(5678));
        assert_eq!(detector.get_parent_pid(5678), None); // PID 1 is filtered out
        assert_eq!(detector.get_parent_pid(9999), None); // Unknown PID
    }

    #[test]
    fn test_get_window_title() {
        let executor = MockCommandExecutor::new()
            .with_window(1234, "Firefox".to_string())
            .with_window(5678, "Default IME".to_string());

        let detector = AppNameDetector::new(Box::new(executor), AppNameConfig::default());

        assert_eq!(detector.get_window_title(1234), Some("Firefox".to_string()));
        assert_eq!(detector.get_window_title(5678), None); // Ignored title
        assert_eq!(detector.get_window_title(9999), None); // No window
    }

    #[test]
    fn test_should_use_fallback() {
        let detector = AppNameDetector::new_system();

        assert!(detector.should_use_fallback("steam_app_359320"));
        assert!(detector.should_use_fallback("steam_app_1234"));
        assert!(!detector.should_use_fallback("Discord"));
        assert!(!detector.should_use_fallback("Firefox"));
    }

    #[test]
    fn test_find_window_title_in_tree_direct() {
        let executor = MockCommandExecutor::new().with_window(1234, "Discord".to_string());

        let detector = AppNameDetector::new(Box::new(executor), AppNameConfig::default());

        assert_eq!(detector.find_window_title_in_tree(1234), Some("Discord".to_string()));
    }

    #[test]
    fn test_find_window_title_in_tree_parent() {
        let executor = MockCommandExecutor::new()
            .with_parent(782169, 782029) // Discord audio -> Discord main
            .with_window(782029, "Discord".to_string());

        let detector = AppNameDetector::new(Box::new(executor), AppNameConfig::default());

        assert_eq!(detector.find_window_title_in_tree(782169), Some("Discord".to_string()));
    }

    #[test]
    fn test_find_window_title_skips_ignored() {
        let executor = MockCommandExecutor::new()
            .with_parent(1234, 5678)
            .with_window(1234, "Default IME".to_string())
            .with_window(5678, "Discord".to_string());

        let detector = AppNameDetector::new(Box::new(executor), AppNameConfig::default());

        assert_eq!(detector.find_window_title_in_tree(1234), Some("Discord".to_string()));
    }

    #[test]
    fn test_find_window_title_steam_app() {
        let executor = MockCommandExecutor::new().with_window(1234, "steam_app_359320".to_string());

        let detector = AppNameDetector::new(Box::new(executor), AppNameConfig::default());

        assert_eq!(detector.find_window_title_in_tree(1234), None);
    }

    #[test]
    fn test_determine_display_name_window_priority() {
        let executor = MockCommandExecutor::new().with_window(1234, "Discord".to_string());

        let detector = AppNameDetector::new(Box::new(executor), AppNameConfig::default());

        assert_eq!(
            detector.determine_display_name(
                "WEBRTC VoiceEngine",
                Some("/usr/bin/discord"),
                Some(1234)
            ),
            "Discord"
        );
    }

    #[test]
    fn test_determine_display_name_app_name_priority() {
        let detector = AppNameDetector::new_system();

        assert_eq!(
            detector.determine_display_name("Firefox", Some("/usr/bin/firefox"), None),
            "Firefox"
        );
    }

    #[test]
    fn test_determine_display_name_binary_fallback() {
        let detector = AppNameDetector::new_system();

        assert_eq!(
            detector.determine_display_name("WEBRTC VoiceEngine", Some("/usr/bin/discord"), None),
            "Discord"
        );
    }

    #[test]
    fn test_determine_display_name_wine() {
        let executor = MockCommandExecutor::new();
        let detector = AppNameDetector::new(Box::new(executor), AppNameConfig::default());

        // Wine should be skipped, Elite Dangerous should be used
        assert_eq!(
            detector.determine_display_name(
                "Elite Dangerous",
                Some("/usr/bin/wine64-preloader"),
                None
            ),
            "Elite Dangerous"
        );
    }

    #[test]
    fn test_is_generic_app_name() {
        assert!(is_generic_app_name("WEBRTC VoiceEngine"));
        assert!(is_generic_app_name("WebRTC Audio"));
        assert!(is_generic_app_name("wine64-preloader"));
        assert!(is_generic_app_name("wine-preloader"));
        assert!(!is_generic_app_name("Discord"));
        assert!(!is_generic_app_name("Firefox"));
        assert!(!is_generic_app_name("Elite Dangerous"));
    }

    #[test]
    fn test_capitalize_first_letter() {
        assert_eq!(capitalize_first_letter("firefox"), "Firefox");
        assert_eq!(capitalize_first_letter("discord"), "Discord");
        assert_eq!(capitalize_first_letter(""), "");
        assert_eq!(capitalize_first_letter("A"), "A");
        assert_eq!(capitalize_first_letter("élite"), "Élite");
    }

    #[test]
    fn test_max_parent_depth() {
        let executor = MockCommandExecutor::new()
            .with_parent(1, 2)
            .with_parent(2, 3)
            .with_parent(3, 4)
            .with_parent(4, 5)
            .with_parent(5, 6)
            .with_window(6, "TooDeep".to_string());

        let mut config = AppNameConfig::default();
        config.max_parent_depth = 3;

        let detector = AppNameDetector::new(Box::new(executor), config);

        // Should stop at depth 3, not reach PID 6
        assert_eq!(detector.find_window_title_in_tree(1), None);
    }

    #[test]
    fn test_complex_discord_scenario() {
        // Simulate real Discord scenario: audio process -> main process
        let executor = MockCommandExecutor::new()
            .with_parent(782169, 782029) // Audio process -> Main Discord
            .with_window(782029, "Discord".to_string());

        let detector = AppNameDetector::new(Box::new(executor), AppNameConfig::default());

        let result = detector.determine_display_name(
            "WEBRTC VoiceEngine",
            Some("/opt/discord/Discord"),
            Some(782169),
        );

        assert_eq!(result, "Discord");
    }

    #[test]
    fn test_complex_steam_game_scenario() {
        // Simulate Steam game: window has steam_app prefix
        let executor = MockCommandExecutor::new().with_window(1234, "steam_app_359320".to_string());

        let detector = AppNameDetector::new(Box::new(executor), AppNameConfig::default());

        let result = detector.determine_display_name(
            "Elite Dangerous",
            Some("/home/user/.steam/steam/steamapps/common/Elite Dangerous/EliteDangerous64.exe"),
            Some(1234),
        );

        // Should use application name since window title is steam_app
        assert_eq!(result, "Elite Dangerous");
    }
}
