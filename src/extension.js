const { Clutter, St, GObject, Gio, GLib } = imports.gi;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const Slider = imports.ui.slider;

const VIRTUAL_SINKS = [
    { name: 'Game', label: 'Game', icon: 'applications-games-symbolic' },
    { name: 'Chat', label: 'Chat', icon: 'user-available-symbolic' },
    { name: 'Media', label: 'Media', icon: 'applications-multimedia-symbolic' }
];

let volumeMenu;
let virtualSinkItems = [];

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
            
            // Filter to only apps not on this sink
            sinkInputs.forEach(input => {
                if (input.sinkId !== ourSinkId) {
                    applicableInputs.push(input);
                }
            });
            
            // Add a header if there are apps
            if (applicableInputs.length > 0) {
                let header = new PopupMenu.PopupMenuItem('Move applications here:', false);
                header.sensitive = false;
                menu.addMenuItem(header);
                menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                
                // Add each application
                applicableInputs.forEach(input => {
                    let item = new PopupMenu.PopupMenuItem(input.appName);
                    item.connect('activate', () => {
                        this._moveApplicationToSink(input.id);
                        // Close the menu after moving
                        menu.close();
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
    
    _parseSinkInputs(output) {
        let inputs = [];
        let blocks = output.split('Sink Input #');
        
        blocks.forEach(block => {
            if (!block.trim()) return;
            
            let idMatch = block.match(/^(\d+)/);
            let appMatch = block.match(/application\.name = "([^"]+)"/);
            let sinkMatch = block.match(/Sink: (\d+)/);
            let nodeMatch = block.match(/node\.name = "([^"]+)"/);
            
            if (idMatch && appMatch) {
                // Check if this is one of our loopback streams
                let isLoopback = nodeMatch && nodeMatch[1].includes('_to_');
                if (!isLoopback) {
                    inputs.push({
                        id: idMatch[1],
                        appName: appMatch[1],
                        sinkId: sinkMatch ? sinkMatch[1] : null
                    });
                }
            }
        });
        
        return inputs;
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
                            
                            // Update the menu if we have a reference
                            if (this._currentMenu) {
                                this._updateApplicationList(this._currentMenu);
                            }
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

function init() {
}

function enable() {
    volumeMenu = Main.panel.statusArea.aggregateMenu._volume._volumeMenu;
    
    let separator = new PopupMenu.PopupSeparatorMenuItem();
    volumeMenu.addMenuItem(separator, 2);
    virtualSinkItems.push(separator);
    
    VIRTUAL_SINKS.forEach((sink, index) => {
        // Create the main slider item
        let item = new VirtualSinkItem(sink);
        volumeMenu.addMenuItem(item, 3 + index * 2);
        virtualSinkItems.push(item);
        
        // Add the submenu selector right below it
        let selector = item.getSinkSelector();
        log(`Virtual Audio Sinks: Adding submenu for ${sink.label}, selector: ${selector}, menu: ${selector.menu}`);
        volumeMenu.addMenuItem(selector, 3 + index * 2 + 1);
        virtualSinkItems.push(selector);
        
        // Set up the submenu
        if (selector.menu) {
            selector.menu.connect('open-state-changed', (menu, open) => {
                log(`Virtual Audio Sinks: Menu state changed for ${sink.label}: ${open ? 'opened' : 'closed'}`);
                if (open) {
                    log(`Virtual Audio Sinks: Opening menu for ${sink.label}`);
                    item._updateApplicationList(menu);
                }
            });
        } else {
            log(`Virtual Audio Sinks: ERROR - No menu found for ${sink.label}`);
        }
    });
}

function disable() {
    virtualSinkItems.forEach(item => {
        item.destroy();
    });
    virtualSinkItems = [];
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