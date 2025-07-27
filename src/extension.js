const { Clutter, St, GObject, Gio, GLib } = imports.gi;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const Slider = imports.ui.slider;

const VIRTUAL_SINKS = [
    { name: 'Game', label: 'Game', icon: 'applications-games-symbolic' },
    { name: 'Chat', label: 'Chat', icon: 'user-available-symbolic' },
    { name: 'Media', label: 'Media', icon: 'applications-multimedia-symbolic' }
];

// Configuration options
const CONFIG = {
    autoRoutingEnabled: true,  // Set to false to disable automatic routing
    cacheTimeout: 2000,       // Milliseconds to cache subprocess results
    debounceDelay: 500        // Milliseconds to debounce updates
};

// Default routing patterns (lowercase for matching)
const DEFAULT_ROUTING = {
    // Media apps
    'firefox': 'Media',
    'chrome': 'Media',
    'chromium': 'Media',
    'brave': 'Media',
    'vivaldi': 'Media',
    'opera': 'Media',
    'spotify': 'Media',
    'vlc': 'Media',
    'mpv': 'Media',
    'rhythmbox': 'Media',
    'totem': 'Media',
    'youtube': 'Media',
    'celluloid': 'Media',
    'gnome-music': 'Media',
    
    // Chat apps
    'discord': 'Chat',
    'slack': 'Chat',
    'teams': 'Chat',
    'zoom': 'Chat',
    'skype': 'Chat',
    'telegram': 'Chat',
    'signal': 'Chat',
    'element': 'Chat',
    'mattermost': 'Chat',
    'whatsapp': 'Chat',
    
    // Default for unassigned apps
    '__default__': 'Game'
};

let volumeMenu;
let virtualSinkItems = [];
let virtualSinkItemsObjects = []; // Store the actual VirtualSinkItem objects
let customRouting = {}; // Store user's manual routing preferences
let cachedSinkInputs = null; // Cache sink inputs to avoid multiple calls
let cacheTimestamp = 0;
let lastSinkInputsHash = null; // Track changes in sink inputs
let updateDebounceTimeout = null; // Debounce UI updates
let pwMonProcess = null; // PipeWire monitor process
let fallbackTimer = null; // Fallback timer for missed events
let rememberedApps = {}; // Remember apps that have been on each sink (sticky list)
let eventProcessingTimeout = null; // Timeout for processing pw-mon events
let menuOpenConnection = null; // Connection to main menu open event

const VirtualSinkItem = GObject.registerClass(
class VirtualSinkItem extends PopupMenu.PopupBaseMenuItem {
    _init(sink) {
        super._init();
        this._sink = sink;
        this._muted = false;
        this._mutedVolume = 0.5; // Default volume to restore if muted from 0
        
        // Create speaker icon that can be clicked to mute
        this._speakerIcon = new St.Button({
            child: new St.Icon({
                icon_name: 'audio-volume-high-symbolic',
                style_class: 'popup-menu-icon'
            }),
            style_class: 'icon-button',
            can_focus: true
        });
        this._speakerIcon.connect('clicked', this._toggleMute.bind(this));
        this.add_child(this._speakerIcon);
        
        // Create slider
        this._slider = new Slider.Slider(0);
        this._sliderChangedId = this._slider.connect('notify::value', this._sliderChanged.bind(this));
        this._slider.accessible_name = sink.label;
        this.add_child(this._slider);
        
        // Create submenu for sink selector and app routing
        // Note: This will be added to the menu separately, not as a child
        this._sinkSelector = new PopupMenu.PopupSubMenuMenuItem(sink.label, true);
        
        // Add sink icon to the submenu with proper alignment
        let sinkIcon = new St.Icon({
            icon_name: sink.icon,
            style_class: 'popup-menu-icon',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER
        });
        // Insert icon at position 1 (after the hidden ornament)
        this._sinkSelector.insert_child_at_index(sinkIcon, 1);
        
        // Add initial placeholder to make submenu functional
        let placeholder = new PopupMenu.PopupMenuItem('Loading...', false);
        placeholder.sensitive = false;
        this._sinkSelector.menu.addMenuItem(placeholder);
        
        // Create read-only list of current apps
        this._currentAppsList = new PopupMenu.PopupMenuItem('', false);
        this._currentAppsList.sensitive = false;
        this._currentAppsList.label.style_class = 'popup-subtitle-menu-item';
        this._currentAppsList.label.style = 'font-size: 90%; opacity: 0.7;';
        this._updateCurrentAppsList();
        
        this.connect('destroy', this._onDestroy.bind(this));
        
        this._updateVolume();
        this._buildSubmenu();
    }
    
    _onDestroy() {
        if (this._sliderChangedId) {
            this._slider.disconnect(this._sliderChangedId);
            this._sliderChangedId = 0;
        }
        if (this._toggleMuteTimeout) {
            GLib.source_remove(this._toggleMuteTimeout);
            this._toggleMuteTimeout = null;
        }
    }
    
    _buildSubmenu() {
        // This will hold the submenu items for app routing
    }
    
    getSinkSelector() {
        return this._sinkSelector;
    }
    
    getCurrentAppsList() {
        return this._currentAppsList;
    }
    
    _updateCurrentAppsList() {
        try {
            // Use cached data when possible
            let data = getCachedSinkInputs();
            let sinkInputs = this._parseSinkInputs(data.raw);
            let ourApps = [];
            
            log(`Virtual Audio Sinks: Updating apps for ${this._sink.label}, found ${sinkInputs.length} total sink inputs`);
            
            // Get sink name mapping from pactl
            let sinkNameMap = this._getSinkNameMapping();
            
            // Find apps on this sink
            // First need to get our sink ID
            let statusProc = Gio.Subprocess.new(
                ['wpctl', 'status'],
                Gio.SubprocessFlags.STDOUT_PIPE
            );
            let [statusSuccess, statusOut] = statusProc.communicate_utf8(null, null);
            
            let ourSinkId = null;
            if (statusSuccess) {
                let lines = statusOut.split('\n');
                for (let line of lines) {
                    if (line.includes(`${this._sink.label} Audio`)) {
                        let idMatch = line.match(/(\d+)\./);
                        if (idMatch) {
                            ourSinkId = idMatch[1];
                            log(`Virtual Audio Sinks: Found sink ID ${ourSinkId} for ${this._sink.label}`);
                            break;
                        }
                    }
                }
            }
            
            if (!ourSinkId) {
                log(`Virtual Audio Sinks: Could not find sink ID for ${this._sink.label} in wpctl output`);
            }
            
            // Check by both sink ID and sink name
            sinkInputs.forEach(input => {
                let inputSinkName = sinkNameMap[input.sinkId] || input.sinkName;
                log(`Virtual Audio Sinks: Checking input ${input.appName} on sink ${input.sinkId}/${inputSinkName} against our sink ${ourSinkId}/${this._sink.name}`);
                
                // Match by sink name (more reliable) or ID
                if (inputSinkName === this._sink.name || 
                    (ourSinkId && input.sinkId === ourSinkId)) {
                    ourApps.push(input.appName);
                    
                    // Remember this app was on this sink
                    if (!rememberedApps[this._sink.name]) {
                        rememberedApps[this._sink.name] = new Set();
                    }
                    rememberedApps[this._sink.name].add(input.appName);
                }
            });
            
            // Build display list combining active and remembered apps
            let displayApps = new Set(ourApps);
            
            // Add remembered apps that aren't currently active
            if (rememberedApps[this._sink.name]) {
                rememberedApps[this._sink.name].forEach(app => {
                    displayApps.add(app);
                });
            }
            
            // Update the label
            if (displayApps.size > 0) {
                // Count active instances
                let appCounts = {};
                ourApps.forEach(app => {
                    appCounts[app] = (appCounts[app] || 0) + 1;
                });
                
                let appList = Array.from(displayApps).map(app => {
                    if (appCounts[app] > 1) {
                        return `${app} (${appCounts[app]})`;
                    } else if (appCounts[app] === 1) {
                        return app;
                    } else {
                        // Remembered but not active - show in brackets
                        return `[${app}]`;
                    }
                }).join(', ');
                
                this._currentAppsList.label.set_text(`Apps: ${appList}`);
                this._currentAppsList.visible = true;
            } else {
                this._currentAppsList.visible = false;
            }
        } catch (e) {
            log(`Virtual Audio Sinks: Error updating current apps list: ${e}`);
            this._currentAppsList.visible = false;
        }
    }
    
    
    _toggleMute() {
        // Prevent rapid toggling
        if (this._toggleMuteTimeout) {
            return;
        }
        
        log(`Virtual Audio Sinks: Toggle mute for ${this._sink.label}. Current muted: ${this._muted}, current volume: ${this._slider.value}, saved volume: ${this._mutedVolume}`);
        
        if (this._muted) {
            // Unmute: restore previous volume
            // If saved volume is 0, restore to a reasonable default
            let volumeToRestore = this._mutedVolume > 0 ? this._mutedVolume : 0.5;
            this._muted = false; // Set state before changing slider
            this._slider.value = volumeToRestore;
            this._updateSpeakerIcon(volumeToRestore);
            log(`Virtual Audio Sinks: Unmuted ${this._sink.label}, restored volume to ${volumeToRestore}`);
        } else {
            // Mute: save current volume and set to 0
            // Only save non-zero volumes
            if (this._slider.value > 0) {
                this._mutedVolume = this._slider.value;
            }
            this._muted = true; // Set state before changing slider
            this._slider.value = 0;
            this._updateSpeakerIcon(0);
            log(`Virtual Audio Sinks: Muted ${this._sink.label}, saved volume ${this._mutedVolume}`);
        }
        
        // Prevent rapid toggling for 200ms
        this._toggleMuteTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            this._toggleMuteTimeout = null;
            return GLib.SOURCE_REMOVE;
        });
    }
    
    _updateSpeakerIcon(volume) {
        let iconName;
        if (volume === 0 || this._muted) {
            iconName = 'audio-volume-muted-symbolic';
        } else if (volume < 0.33) {
            iconName = 'audio-volume-low-symbolic';
        } else if (volume < 0.67) {
            iconName = 'audio-volume-medium-symbolic';
        } else {
            iconName = 'audio-volume-high-symbolic';
        }
        
        this._speakerIcon.child.icon_name = iconName;
    }
    
    _updateApplicationList(menu) {
        // Store menu reference for later updates
        this._currentMenu = menu;
        
        // Clear existing menu items
        menu.removeAll();
        
        try {
            // First get our sink ID
            let statusProc = Gio.Subprocess.new(
                ['wpctl', 'status'],
                Gio.SubprocessFlags.STDOUT_PIPE
            );
            let [statusSuccess, statusOut] = statusProc.communicate_utf8(null, null);
            
            let ourSinkId = null;
            if (statusSuccess) {
                let lines = statusOut.split('\n');
                for (let line of lines) {
                    if (line.includes(`${this._sink.label} Audio`)) {
                        let idMatch = line.match(/(\d+)\./);
                        if (idMatch) {
                            ourSinkId = idMatch[1];
                            break;
                        }
                    }
                }
            }
            
            // Get all sink inputs (audio streams)
            let proc = Gio.Subprocess.new(
                ['pactl', 'list', 'sink-inputs'],
                Gio.SubprocessFlags.STDOUT_PIPE
            );
            
            let [success, stdout] = proc.communicate_utf8(null, null);
            if (!success) return;
            
            let sinkInputs = this._parseSinkInputs(stdout);
            let applicableInputs = [];
            let seenApps = new Set();
            
            // Get sink name mapping
            let sinkNameMap = this._getSinkNameMapping();
            
            // Filter to only apps not on this sink
            sinkInputs.forEach(input => {
                if (input.sinkId !== ourSinkId) {
                    applicableInputs.push(input);
                    seenApps.add(input.appName);
                }
            });
            
            // Add remembered apps that aren't currently active
            for (let sinkName in rememberedApps) {
                if (sinkName !== this._sink.name) {
                    rememberedApps[sinkName].forEach(appName => {
                        if (!seenApps.has(appName)) {
                            // Add a placeholder entry for remembered apps
                            applicableInputs.push({
                                id: null,
                                appName: appName,
                                sinkName: sinkName,
                                remembered: true
                            });
                            seenApps.add(appName);
                        }
                    });
                }
            }
            
            // Add a header if there are apps
            if (applicableInputs.length > 0) {
                let header = new PopupMenu.PopupMenuItem('Add app:', false);
                header.sensitive = false;
                menu.addMenuItem(header);
                
                // Group applications by name
                let appGroups = {};
                applicableInputs.forEach(input => {
                    if (!appGroups[input.appName]) {
                        appGroups[input.appName] = [];
                    }
                    appGroups[input.appName].push(input);
                });
                
                // Add menu items for each app group (sorted alphabetically)
                Object.keys(appGroups).sort().forEach(appName => {
                    let group = appGroups[appName];
                    let activeCount = group.filter(g => !g.remembered).length;
                    let isRemembered = group.some(g => g.remembered);
                    
                    let label = appName;
                    if (isRemembered && activeCount === 0) {
                        label = `[${appName}]`; // Show brackets for inactive remembered apps
                    } else if (activeCount > 1) {
                        label += ` (${activeCount} instances)`;
                    }
                    
                    let item = new PopupMenu.PopupMenuItem(label);
                    item.connect('activate', () => {
                        // Save routing preference
                        customRouting[appName.toLowerCase()] = this._sink.name;
                        saveCustomRouting();
                        
                        // Move all active instances of this app
                        group.forEach(input => {
                            if (!input.remembered && input.id) {
                                this._moveApplicationToSink(input.id);
                            }
                        });
                        
                        // Update remembered apps
                        if (!rememberedApps[this._sink.name]) {
                            rememberedApps[this._sink.name] = new Set();
                        }
                        rememberedApps[this._sink.name].add(appName);
                        
                        // Remove from other sinks' remembered lists
                        for (let sinkName in rememberedApps) {
                            if (sinkName !== this._sink.name) {
                                rememberedApps[sinkName].delete(appName);
                            }
                        }
                        
                        // Close the menu after moving
                        menu.close();
                        
                        // Update all UI
                        virtualSinkItemsObjects.forEach(obj => {
                            obj._updateCurrentAppsList();
                        });
                    });
                    menu.addMenuItem(item);
                });
            } else {
                // No apps to move
                let empty = new PopupMenu.PopupMenuItem('No applications to move', false);
                empty.sensitive = false;
                menu.addMenuItem(empty);
            }
        } catch (e) {
            log(`Virtual Audio Sinks: Error updating app list: ${e}`);
        }
    }
    
    _getSinkNameMapping() {
        // Get mapping of sink IDs to names
        let map = {};
        try {
            let proc = Gio.Subprocess.new(
                ['pactl', 'list', 'sinks', 'short'],
                Gio.SubprocessFlags.STDOUT_PIPE
            );
            let [success, stdout] = proc.communicate_utf8(null, null);
            if (success) {
                let lines = stdout.split('\n');
                lines.forEach(line => {
                    let parts = line.split('\t');
                    if (parts.length >= 2) {
                        let id = parts[0];
                        let name = parts[1];
                        map[id] = name;
                        log(`Virtual Audio Sinks: Sink ${id} is named ${name}`);
                    }
                });
            }
        } catch (e) {
            log('Virtual Audio Sinks: Error getting sink name mapping: ' + e);
        }
        return map;
    }
    
    _parseSinkInputs(output) {
        let inputs = [];
        let blocks = output.split('Sink Input #');
        
        blocks.forEach(block => {
            if (!block.trim()) return;
            
            let idMatch = block.match(/^(\d+)/);
            let appMatch = block.match(/application\.name = "([^"]+)"/);
            let binaryMatch = block.match(/application\.process\.binary = "([^"]+)"/);
            let sinkMatch = block.match(/Sink: (\d+)/);
            let nodeMatch = block.match(/node\.name = "([^"]+)"/);
            
            // Also try to get sink name for better matching
            let sinkNameMatch = null;
            if (sinkMatch) {
                // The sink name usually appears after the sink number
                let sinkLineMatch = block.match(/Sink: \d+\s+(\S+)/);
                if (sinkLineMatch) {
                    sinkNameMatch = sinkLineMatch[1];
                }
            }
            
            if (idMatch && (appMatch || binaryMatch)) {
                // Check if this is one of our loopback streams
                let isLoopback = nodeMatch && nodeMatch[1].includes('_to_');
                if (!isLoopback) {
                    // Prefer binary name for identification
                    let displayName;
                    if (binaryMatch) {
                        let binary = binaryMatch[1];
                        // Extract app name from binary path
                        displayName = binary.split('/').pop();
                        // Clean up common patterns
                        displayName = displayName
                            .replace(/-bin$/, '')
                            .replace(/\.exe$/, '')
                            .replace(/^electron-/, '');
                        // Capitalize first letter
                        displayName = displayName.charAt(0).toUpperCase() + displayName.slice(1);
                    } else {
                        displayName = appMatch[1];
                    }
                    
                    let sinkId = sinkMatch ? sinkMatch[1] : null;
                    inputs.push({
                        id: idMatch[1],
                        appName: displayName,
                        sinkId: sinkId,
                        sinkName: sinkNameMatch
                    });
                    log(`Virtual Audio Sinks: Parsed sink input: ${displayName} on sink ${sinkId} (${sinkNameMatch})`);
                }
            }
        });
        
        return inputs;
    }
    
    _getAppNameForInput(inputId) {
        try {
            let proc = Gio.Subprocess.new(
                ['pactl', 'list', 'sink-inputs'],
                Gio.SubprocessFlags.STDOUT_PIPE
            );
            
            let [success, stdout] = proc.communicate_utf8(null, null);
            if (success) {
                let blocks = stdout.split('Sink Input #');
                for (let block of blocks) {
                    if (block.startsWith(inputId)) {
                        let appMatch = block.match(/application\.name = "([^"]+)"/);
                        if (appMatch) {
                            return appMatch[1];
                        }
                    }
                }
            }
        } catch (e) {
            log(`Virtual Audio Sinks: Error getting app name: ${e}`);
        }
        return null;
    }
    
    _moveApplicationToSink(inputId) {
        try {
            // Get the sink ID for this virtual sink
            let statusProc = Gio.Subprocess.new(
                ['wpctl', 'status'],
                Gio.SubprocessFlags.STDOUT_PIPE
            );
            let [success, stdout] = statusProc.communicate_utf8(null, null);
            
            if (success) {
                let lines = stdout.split('\n');
                for (let line of lines) {
                    if (line.includes(`${this._sink.label} Audio`)) {
                        let idMatch = line.match(/(\d+)\./);
                        if (idMatch) {
                            let sinkId = idMatch[1];
                            
                            // Move the sink input
                            Gio.Subprocess.new(
                                ['pactl', 'move-sink-input', inputId, sinkId],
                                Gio.SubprocessFlags.NONE
                            );
                            
                            log(`Virtual Audio Sinks: Moved input ${inputId} to sink ${sinkId}`);
                            
                            // Remember this routing preference
                            let appName = this._getAppNameForInput(inputId);
                            if (appName) {
                                customRouting[appName] = this._sink.label;
                                saveCustomRouting();
                                log(`Virtual Audio Sinks: Saved routing preference: ${appName} -> ${this._sink.label}`);
                            }
                            
                            // Update the menu if we have a reference
                            if (this._currentMenu) {
                                this._updateApplicationList(this._currentMenu);
                            }
                            
                            // Schedule UI update after routing
                            scheduleUIUpdate();
                            break;
                        }
                    }
                }
            }
        } catch (e) {
            log(`Virtual Audio Sinks: Error moving application: ${e}`);
        }
    }
    
    _updateVolume() {
        try {
            // Get loopback sink input volume
            let proc = Gio.Subprocess.new(
                ['pactl', 'list', 'sink-inputs'],
                Gio.SubprocessFlags.STDOUT_PIPE
            );
            
            let [success, stdout, stderr] = proc.communicate_utf8(null, null);
            if (!success) return;
            
            let blocks = stdout.split('Sink Input #');
            for (let block of blocks) {
                if (block.includes(`node.name = "${this._sink.name}_to_Speaker"`)) {
                    let volMatch = block.match(/Volume:.*?(\d+)%/);
                    if (volMatch) {
                        let volume = parseInt(volMatch[1]) / 100;
                        // Temporarily disconnect to avoid feedback loop
                        this._slider.block_signal_handler(this._sliderChangedId);
                        this._slider.value = volume;
                        this._slider.unblock_signal_handler(this._sliderChangedId);
                        this._updateSpeakerIcon(volume);
                        // Reset mute state if volume changed externally
                        if (volume > 0) {
                            this._muted = false;
                        }
                    }
                    return;
                }
            }
            
            // Fallback to sink volume if loopback not found
            let wpctl = Gio.Subprocess.new(
                ['wpctl', 'status'],
                Gio.SubprocessFlags.STDOUT_PIPE
            );
            let [success2, stdout2] = wpctl.communicate_utf8(null, null);
            if (success2) {
                let lines = stdout2.split('\n');
                for (let line of lines) {
                    if (line.includes(`${this._sink.label} Audio`)) {
                        let volMatch = line.match(/\[vol:\s*([\d.]+)\]/);
                        if (volMatch) {
                            let volume = parseFloat(volMatch[1]);
                            this._slider.block_signal_handler(this._sliderChangedId);
                            this._slider.value = volume;
                            this._slider.unblock_signal_handler(this._sliderChangedId);
                        }
                        break;
                    }
                }
            }
        } catch (e) {
            log(`Virtual Audio Sinks: Error updating volume: ${e}`);
        }
    }
    
    _sliderChanged() {
        let volume = this._slider.value;
        log(`Virtual Audio Sinks: Slider changed for ${this._sink.label} to ${volume}`);
        
        // Update speaker icon based on new volume
        this._updateSpeakerIcon(volume);
        
        // If we're unmuting by moving the slider, reset mute state
        if (this._muted && volume > 0) {
            this._muted = false;
        }
        
        try {
            // Find the sink ID first
            let statusProc = Gio.Subprocess.new(
                ['wpctl', 'status'],
                Gio.SubprocessFlags.STDOUT_PIPE
            );
            let [success, stdout] = statusProc.communicate_utf8(null, null);
            if (success) {
                let lines = stdout.split('\n');
                for (let line of lines) {
                    if (line.includes(`${this._sink.label} Audio`)) {
                        let idMatch = line.match(/(\d+)\./);
                        if (idMatch) {
                            let sinkId = idMatch[1];
                            log(`Virtual Audio Sinks: Setting volume for sink ${sinkId} to ${volume}`);
                            let setProc = Gio.Subprocess.new(
                                ['wpctl', 'set-volume', sinkId, `${volume}`],
                                Gio.SubprocessFlags.NONE
                            );
                            
                            // Find and set volume on the loopback sink input
                            let findLoopback = Gio.Subprocess.new(
                                ['pactl', 'list', 'sink-inputs'],
                                Gio.SubprocessFlags.STDOUT_PIPE
                            );
                            let [success2, stdout2] = findLoopback.communicate_utf8(null, null);
                            if (success2) {
                                let blocks = stdout2.split('Sink Input #');
                                for (let block of blocks) {
                                    if (block.includes(`node.name = "${this._sink.name}_to_Speaker"`)) {
                                        let idMatch = block.match(/^(\d+)/);
                                        if (idMatch) {
                                            let loopbackId = idMatch[1];
                                            let volumePercent = Math.round(volume * 100);
                                            log(`Virtual Audio Sinks: Setting loopback ${loopbackId} volume to ${volumePercent}%`);
                                            let setLoopbackVol = Gio.Subprocess.new(
                                                ['pactl', 'set-sink-input-volume', loopbackId, `${volumePercent}%`],
                                                Gio.SubprocessFlags.NONE
                                            );
                                            break;
                                        }
                                    }
                                }
                            }
                            
                            return;
                        }
                    }
                }
            }
        } catch (e) {
            // Try with pactl as fallback
            try {
                let volumePercent = Math.round(volume * 100);
                let proc2 = Gio.Subprocess.new(
                    ['pactl', 'set-sink-volume', this._sink.name, `${volumePercent}%`],
                    Gio.SubprocessFlags.NONE
                );
            } catch (e2) {
                log(`Virtual Audio Sinks: Error setting volume: ${e2}`);
            }
        }
    }
});

// Get sink inputs with caching and change detection
function getCachedSinkInputs(forceRefresh = false) {
    log('Virtual Audio Sinks: getCachedSinkInputs() called, forceRefresh=' + forceRefresh);
    let now = Date.now();
    // Use configured cache timeout
    if (!forceRefresh && cachedSinkInputs && (now - cacheTimestamp) < CONFIG.cacheTimeout) {
        log('Virtual Audio Sinks: Using cached sink inputs');
        return cachedSinkInputs;
    }
    
    try {
        log('Virtual Audio Sinks: Running pactl list sink-inputs');
        // Get all sink inputs in one call
        let proc = Gio.Subprocess.new(
            ['pactl', 'list', 'sink-inputs'],
            Gio.SubprocessFlags.STDOUT_PIPE
        );
        
        let [success, stdout] = proc.communicate_utf8(null, null);
        if (!success) return { inputs: [], raw: '', changed: false };
        
        // Create a simple hash to detect changes
        let currentHash = stdout.length + stdout.split('Sink Input #').length;
        let changed = lastSinkInputsHash !== currentHash;
        lastSinkInputsHash = currentHash;
        
        cachedSinkInputs = {
            inputs: parseSinkInputsForRouting(stdout),
            raw: stdout,
            changed: changed
        };
        cacheTimestamp = now;
        
        return cachedSinkInputs;
    } catch (e) {
        log('Virtual Audio Sinks: Error getting sink inputs: ' + e);
        return { inputs: [], raw: '', changed: false };
    }
}

// Debounced UI update function
function scheduleUIUpdate() {
    if (updateDebounceTimeout) {
        GLib.source_remove(updateDebounceTimeout);
    }
    
    updateDebounceTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CONFIG.debounceDelay, () => {
        // Clear cache completely and force refresh
        cachedSinkInputs = null;
        cacheTimestamp = 0;
        lastSinkInputsHash = null;
        
        log('Virtual Audio Sinks: Updating app lists due to PipeWire event');
        virtualSinkItemsObjects.forEach(item => {
            item._updateCurrentAppsList();
        });
        updateDebounceTimeout = null;
        return GLib.SOURCE_REMOVE;
    });
}

// Start PipeWire monitor for real-time events
function startPipeWireMonitor() {
    if (pwMonProcess) {
        return; // Already running
    }
    
    try {
        pwMonProcess = Gio.Subprocess.new(
            ['pw-mon'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
        );
        
        let stdout = pwMonProcess.get_stdout_pipe();
        let dataInputStream = Gio.DataInputStream.new(stdout);
        
        // Read lines asynchronously
        readPipeWireEvents(dataInputStream);
        
        log('Virtual Audio Sinks: Started PipeWire monitor');
    } catch (e) {
        log('Virtual Audio Sinks: Error starting pw-mon: ' + e);
        pwMonProcess = null;
    }
}

// Read PipeWire events from pw-mon
function readPipeWireEvents(dataInputStream) {
    dataInputStream.read_line_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
        try {
            let [line, length] = source.read_line_finish(result);
            if (line) {
                let lineStr = line.toString().trim();
                processPipeWireEvent(lineStr);
                // Continue reading
                readPipeWireEvents(dataInputStream);
            }
        } catch (e) {
            log('Virtual Audio Sinks: Error reading pw-mon output: ' + e);
        }
    });
}

// Process individual PipeWire events
function processPipeWireEvent(line) {
    // Only process actual add/remove/change events, not the verbose property dumps
    if (line.includes('added:') || line.includes('removed:') || line.includes('changed:')) {
        // Look for audio stream events specifically
        if (line.includes('PipeWire:Interface:Node') || 
            line.includes('Stream/Output/Audio') ||
            line.includes('Stream/Input/Audio')) {
            
            // Debounce event processing to avoid spam
            if (eventProcessingTimeout) {
                GLib.source_remove(eventProcessingTimeout);
            }
            
            eventProcessingTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                if (CONFIG.autoRoutingEnabled) {
                    monitorNewStreams(true);
                }
                scheduleUIUpdate();
                eventProcessingTimeout = null;
                return GLib.SOURCE_REMOVE;
            });
        }
    }
}

// Stop PipeWire monitor
function stopPipeWireMonitor() {
    if (pwMonProcess) {
        try {
            pwMonProcess.force_exit();
            pwMonProcess = null;
            log('Virtual Audio Sinks: Stopped PipeWire monitor');
        } catch (e) {
            log('Virtual Audio Sinks: Error stopping pw-mon: ' + e);
        }
    }
}

// Load custom routing from GSettings or file
function loadCustomRouting() {
    try {
        let configPath = GLib.get_user_config_dir() + '/pipewire-volume-mixer-routing.json';
        let [success, contents] = GLib.file_get_contents(configPath);
        if (success) {
            customRouting = JSON.parse(contents);
            log('Virtual Audio Sinks: Loaded custom routing for ' + Object.keys(customRouting).length + ' apps');
        }
    } catch (e) {
        // File doesn't exist yet, that's ok
        customRouting = {};
    }
}

// Save custom routing to persistent storage
function saveCustomRouting() {
    try {
        let configPath = GLib.get_user_config_dir() + '/pipewire-volume-mixer-routing.json';
        let contents = JSON.stringify(customRouting, null, 2);
        GLib.file_set_contents(configPath, contents);
        log('Virtual Audio Sinks: Saved custom routing');
    } catch (e) {
        log('Virtual Audio Sinks: Error saving routing: ' + e);
    }
}

// Get the target sink for an application
function getTargetSinkForApp(appName) {
    if (!appName) return DEFAULT_ROUTING['__default__'];
    
    // Check custom routing first (user preferences)
    if (customRouting[appName]) {
        return customRouting[appName];
    }
    
    // Check default routing patterns
    let appNameLower = appName.toLowerCase();
    for (let pattern in DEFAULT_ROUTING) {
        if (pattern !== '__default__' && appNameLower.includes(pattern)) {
            return DEFAULT_ROUTING[pattern];
        }
    }
    
    // Default to Game sink
    return DEFAULT_ROUTING['__default__'];
}

// Monitor for new audio streams and route them - with optional force check
function monitorNewStreams(forceCheck = false) {
    log('Virtual Audio Sinks: monitorNewStreams() called');
    try {
        log('Virtual Audio Sinks: Getting cached sink inputs');
        let data = getCachedSinkInputs(true); // Force refresh for monitoring
        
        // Only process if there are actual changes (unless forced)
        if (!forceCheck && !data.changed) {
            return;
        }
        
        let sinkInputs = data.inputs;
        let routedAny = false;
        
        sinkInputs.forEach(input => {
            // Skip if already on a virtual sink
            if (input.sinkName && (input.sinkName.includes('Game') || 
                                 input.sinkName.includes('Chat') || 
                                 input.sinkName.includes('Media'))) {
                return;
            }
            
            // Get target sink for this app
            let targetSink = getTargetSinkForApp(input.appName);
            
            // Route to target sink
            routeAppToSink(input.id, targetSink);
            routedAny = true;
        });
        
        // Schedule UI update only if we routed something
        if (routedAny) {
            scheduleUIUpdate();
        }
    } catch (e) {
        log('Virtual Audio Sinks: Error monitoring streams: ' + e);
    }
}

// Parse sink inputs for routing
function parseSinkInputsForRouting(output) {
    let inputs = [];
    let blocks = output.split('Sink Input #');
    
    blocks.forEach(block => {
        if (!block.trim()) return;
        
        let idMatch = block.match(/^(\d+)/);
        let appMatch = block.match(/application\.name = "([^"]+)"/);
        let binaryMatch = block.match(/application\.process\.binary = "([^"]+)"/);
        let sinkMatch = block.match(/Sink: \d+/);
        let nodeMatch = block.match(/node\.name = "([^"]+)"/);
        
        if (idMatch && (appMatch || binaryMatch)) {
            // Skip loopback streams
            let isLoopback = nodeMatch && nodeMatch[1].includes('_to_');
            if (!isLoopback) {
                // Get current sink name
                let sinkNameMatch = block.match(/Sink: \d+\s*\n[^\n]*\n[^\n]*node\.nick = "([^"]+)"/);
                
                // Prefer binary name for identification
                let displayName;
                if (binaryMatch) {
                    let binary = binaryMatch[1];
                    // Extract app name from binary path
                    displayName = binary.split('/').pop();
                    // Clean up common patterns
                    displayName = displayName
                        .replace(/-bin$/, '')
                        .replace(/\.exe$/, '')
                        .replace(/^electron-/, '');
                    // Capitalize first letter
                    displayName = displayName.charAt(0).toUpperCase() + displayName.slice(1);
                } else {
                    displayName = appMatch[1];
                }
                
                inputs.push({
                    id: idMatch[1],
                    appName: displayName,
                    sinkName: sinkNameMatch ? sinkNameMatch[1] : null
                });
            }
        }
    });
    
    return inputs;
}

// Route an app to a specific sink
function routeAppToSink(inputId, sinkLabel) {
    try {
        // Get the sink ID for the target virtual sink
        let statusProc = Gio.Subprocess.new(
            ['wpctl', 'status'],
            Gio.SubprocessFlags.STDOUT_PIPE
        );
        let [success, stdout] = statusProc.communicate_utf8(null, null);
        
        if (success) {
            let lines = stdout.split('\n');
            for (let line of lines) {
                if (line.includes(`${sinkLabel} Audio`)) {
                    let idMatch = line.match(/(\d+)\./);
                    if (idMatch) {
                        let sinkId = idMatch[1];
                        
                        // Move the sink input
                        Gio.Subprocess.new(
                            ['pactl', 'move-sink-input', inputId, sinkId],
                            Gio.SubprocessFlags.NONE
                        );
                        
                        log(`Virtual Audio Sinks: Auto-routed input ${inputId} to ${sinkLabel}`);
                        break;
                    }
                }
            }
        }
    } catch (e) {
        log(`Virtual Audio Sinks: Error routing app: ${e}`);
    }
}

function init() {
    loadCustomRouting();
}

function enable() {
    log('Virtual Audio Sinks: Starting enable()');
    
    try {
        log('Virtual Audio Sinks: Getting volume menu');
        volumeMenu = Main.panel.statusArea.aggregateMenu._volume._volumeMenu;
        
        // Connect to the main menu opening to refresh app lists
        let aggregateMenu = Main.panel.statusArea.aggregateMenu;
        if (aggregateMenu && aggregateMenu.menu) {
            menuOpenConnection = aggregateMenu.menu.connect('open-state-changed', (menu, open) => {
                if (open) {
                    log('Virtual Audio Sinks: Main volume menu opened, refreshing app lists');
                    // Clear cache and force update
                    cachedSinkInputs = null;
                    cacheTimestamp = 0;
                    
                    // Check for new streams and update all app lists
                    if (CONFIG.autoRoutingEnabled) {
                        monitorNewStreams(true);
                    }
                    
                    // Update all app lists immediately
                    virtualSinkItemsObjects.forEach(item => {
                        item._updateCurrentAppsList();
                    });
                }
            });
        }
        
        log('Virtual Audio Sinks: Creating separator');
        let separator = new PopupMenu.PopupSeparatorMenuItem();
        volumeMenu.addMenuItem(separator, 2);
        virtualSinkItems.push(separator);
        
        log('Virtual Audio Sinks: Separator added');
        
        // Start real-time PipeWire monitoring with safer event processing
        startPipeWireMonitor();
        
        log('Virtual Audio Sinks: About to call monitorNewStreams()');
        // Initial check and setup
        monitorNewStreams();
        log('Virtual Audio Sinks: monitorNewStreams() completed');
    } catch (e) {
        log('Virtual Audio Sinks: ERROR in enable(): ' + e);
    }
    
    log('Virtual Audio Sinks: About to create sink items');
    VIRTUAL_SINKS.forEach((sink, index) => {
        log('Virtual Audio Sinks: Creating item for sink: ' + sink.label);
        // Create the main slider item
        let item = new VirtualSinkItem(sink);
        volumeMenu.addMenuItem(item, 3 + index * 4);
        virtualSinkItems.push(item);
        virtualSinkItemsObjects.push(item);
        
        // Add the submenu selector right below it
        let selector = item.getSinkSelector();
        log(`Virtual Audio Sinks: Adding submenu for ${sink.label}, selector: ${selector}, menu: ${selector.menu}`);
        volumeMenu.addMenuItem(selector, 3 + index * 4 + 1);
        virtualSinkItems.push(selector);
        
        // Add the current apps list
        let appsList = item.getCurrentAppsList();
        volumeMenu.addMenuItem(appsList, 3 + index * 4 + 2);
        virtualSinkItems.push(appsList);
        
        // Add separator after each sink group
        let sinkSeparator = new PopupMenu.PopupSeparatorMenuItem();
        volumeMenu.addMenuItem(sinkSeparator, 3 + index * 4 + 3);
        virtualSinkItems.push(sinkSeparator);
        
        // Set up the submenu with event-driven updates
        if (selector.menu) {
            selector.menu.connect('open-state-changed', (menu, open) => {
                log(`Virtual Audio Sinks: Menu state changed for ${sink.label}: ${open ? 'opened' : 'closed'}`);
                if (open) {
                    log(`Virtual Audio Sinks: Opening menu for ${sink.label}`);
                    // Only update the application list when menu is opened
                    item._updateApplicationList(menu);
                }
            });
        } else {
            log(`Virtual Audio Sinks: ERROR - No menu found for ${sink.label}`);
        }
    });
    
    log('Virtual Audio Sinks: Extension enable() completed successfully');
}

function disable() {
    // Stop PipeWire monitor
    stopPipeWireMonitor();
    
    // Disconnect menu open handler
    if (menuOpenConnection) {
        let aggregateMenu = Main.panel.statusArea.aggregateMenu;
        if (aggregateMenu && aggregateMenu.menu) {
            aggregateMenu.menu.disconnect(menuOpenConnection);
        }
        menuOpenConnection = null;
    }
    
    // Stop event processing timeout
    if (eventProcessingTimeout) {
        GLib.source_remove(eventProcessingTimeout);
        eventProcessingTimeout = null;
    }
    
    // Stop any running timeouts
    if (updateDebounceTimeout) {
        GLib.source_remove(updateDebounceTimeout);
        updateDebounceTimeout = null;
    }
    
    // Note: No more menu monitoring timeouts needed with pw-mon
    
    // Clear cache
    cachedSinkInputs = null;
    cacheTimestamp = 0;
    lastSinkInputsHash = null;
    
    virtualSinkItems.forEach(item => {
        item.destroy();
    });
    virtualSinkItems = [];
    virtualSinkItemsObjects = [];
}

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        VIRTUAL_SINKS,
        VirtualSinkItem,
        enable,
        disable,
        volumeMenu,
        virtualSinkItems
    };
}