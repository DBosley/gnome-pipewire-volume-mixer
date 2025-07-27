const { Clutter, St, GObject, GLib } = imports.gi;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const Slider = imports.ui.slider;

// Import our backends
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const DaemonBackend = Me.imports.daemonBackend.DaemonBackend;

const VIRTUAL_SINKS = [
    { name: 'Game', label: 'Game', icon: 'applications-games-symbolic' },
    { name: 'Chat', label: 'Chat', icon: 'user-available-symbolic' },
    { name: 'Media', label: 'Media', icon: 'applications-multimedia-symbolic' }
];

let volumeMenu;
let virtualSinkItems = [];
let virtualSinkItemsObjects = [];
let backend = null;
let menuOpenConnection = null;

const VirtualSinkItem = GObject.registerClass(
class VirtualSinkItem extends PopupMenu.PopupBaseMenuItem {
    _init(sink) {
        super._init();
        this._sink = sink;
        this._muted = false;
        this._mutedVolume = 0.5;
        
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
        
        // Create submenu for app routing
        this._sinkSelector = new PopupMenu.PopupSubMenuMenuItem(sink.label, true);
        
        // Add sink icon
        let sinkIcon = new St.Icon({
            icon_name: sink.icon,
            style_class: 'popup-menu-icon',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER
        });
        this._sinkSelector.insert_child_at_index(sinkIcon, 1);
        
        // Add placeholder to make submenu functional
        let placeholder = new PopupMenu.PopupMenuItem('Loading...', false);
        placeholder.sensitive = false;
        this._sinkSelector.menu.addMenuItem(placeholder);
        
        // Create read-only list of current apps
        this._currentAppsList = new PopupMenu.PopupMenuItem('', false);
        this._currentAppsList.sensitive = false;
        this._currentAppsList.label.style_class = 'popup-subtitle-menu-item';
        this._currentAppsList.label.style = 'font-size: 90%; opacity: 0.7;';
        
        this.connect('destroy', this._onDestroy.bind(this));
        
        this._updateFromBackend();
    }
    
    _onDestroy() {
        if (this._sliderChangedId) {
            this._slider.disconnect(this._sliderChangedId);
            this._sliderChangedId = 0;
        }
    }
    
    getSinkSelector() {
        return this._sinkSelector;
    }
    
    getCurrentAppsList() {
        return this._currentAppsList;
    }
    
    _updateFromBackend() {
        if (!backend) return;
        
        // Update volume from backend
        let sinks = backend.getSinks();
        let sinkInfo = sinks[this._sink.name];
        
        if (sinkInfo) {
            this._slider.block_signal_handler(this._sliderChangedId);
            this._slider.value = sinkInfo.volume;
            this._slider.unblock_signal_handler(this._sliderChangedId);
            
            this._muted = sinkInfo.muted;
            this._updateSpeakerIcon(sinkInfo.muted ? 0 : sinkInfo.volume);
        }
        
        // Update app list
        this._updateCurrentAppsList();
    }
    
    _updateCurrentAppsList() {
        if (!backend) return;
        
        let apps = backend.getAppsForSink(this._sink.name);
        
        if (apps.length > 0) {
            let appNames = apps.map(app => {
                return app.active ? app.displayName : `[${app.displayName}]`;
            }).join(', ');
            
            this._currentAppsList.label.set_text(`Apps: ${appNames}`);
            this._currentAppsList.visible = true;
        } else {
            this._currentAppsList.visible = false;
        }
    }
    
    _updateApplicationList(menu) {
        if (!backend) return;
        
        // Clear existing menu items
        menu.removeAll();
        
        // Get all apps
        let allApps = backend.getApps();
        let ourApps = backend.getAppsForSink(this._sink.name);
        let ourAppNames = new Set(ourApps.map(a => a.name));
        
        // Get apps not on this sink
        let availableApps = Object.entries(allApps)
            .filter(([name, _]) => !ourAppNames.has(name))
            .map(([name, app]) => ({
                name: name,
                displayName: app.displayName,
                active: app.active
            }));
        
        if (availableApps.length > 0) {
            let header = new PopupMenu.PopupMenuItem('Add app:', false);
            header.sensitive = false;
            menu.addMenuItem(header);
            
            availableApps.forEach(app => {
                let label = app.active ? app.displayName : `[${app.displayName}]`;
                let item = new PopupMenu.PopupMenuItem(label);
                
                item.connect('activate', async () => {
                    try {
                        await backend.routeApp(app.name, this._sink.name);
                        
                        // Update UI after routing
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                            updateAllSinks();
                            return GLib.SOURCE_REMOVE;
                        });
                        
                        menu.close();
                    } catch (e) {
                        log(`Virtual Audio Sinks: Error routing app: ${e}`);
                    }
                });
                
                menu.addMenuItem(item);
            });
        } else {
            let empty = new PopupMenu.PopupMenuItem('No applications to move', false);
            empty.sensitive = false;
            menu.addMenuItem(empty);
        }
    }
    
    _toggleMute() {
        if (!backend) return;
        
        // Toggle mute state
        this._muted = !this._muted;
        
        // If unmuting and volume was 0, restore to saved volume
        if (!this._muted && this._slider.value === 0) {
            this._slider.value = this._mutedVolume || 0.5;
        }
        
        // Update backend
        backend.setMute(this._sink.name, this._muted).catch(e => {
            log(`Virtual Audio Sinks: Error setting mute: ${e}`);
        });
        
        this._updateSpeakerIcon(this._muted ? 0 : this._slider.value);
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
    
    _sliderChanged() {
        if (!backend) return;
        
        let volume = this._slider.value;
        
        // Save volume for unmute
        if (volume > 0) {
            this._mutedVolume = volume;
            this._muted = false;
        }
        
        this._updateSpeakerIcon(volume);
        
        // Update backend
        backend.setVolume(this._sink.name, volume).catch(e => {
            log(`Virtual Audio Sinks: Error setting volume: ${e}`);
        });
    }
});

function initBackend() {
    // Only use daemon backend
    let daemonBackend = new DaemonBackend();
    if (daemonBackend.isDaemonAvailable()) {
        log('Virtual Audio Sinks: Using high-performance daemon backend');
        return daemonBackend;
    }
    
    // No fallback - daemon is required
    daemonBackend.destroy();
    log('Virtual Audio Sinks: ERROR - Daemon not available!');
    Main.notifyError('PipeWire Volume Mixer', 'Daemon service not running. Please start pipewire-volume-mixer-daemon.service');
    return null;
}

function updateAllSinks() {
    if (!backend) return;
    virtualSinkItemsObjects.forEach(item => {
        item._updateFromBackend();
    });
}

// eslint-disable-next-line no-unused-vars
function init() {
    log('Virtual Audio Sinks: Extension initialized');
}

function enable() {
    log('Virtual Audio Sinks: Enabling extension');
    
    // Initialize backend
    backend = initBackend();
    if (!backend) {
        // Show error in menu
        try {
            volumeMenu = Main.panel.statusArea.aggregateMenu._volume._volumeMenu;
            let errorItem = new PopupMenu.PopupMenuItem('⚠️ Daemon not running', false);
            errorItem.sensitive = false;
            volumeMenu.addMenuItem(errorItem, 2);
            virtualSinkItems.push(errorItem);
        } catch (_e) {
            log('Virtual Audio Sinks: Failed to show error in menu');
        }
        return;
    }
    
    try {
        volumeMenu = Main.panel.statusArea.aggregateMenu._volume._volumeMenu;
        
        // Connect to menu opening to refresh data
        let aggregateMenu = Main.panel.statusArea.aggregateMenu;
        if (aggregateMenu && aggregateMenu.menu) {
            menuOpenConnection = aggregateMenu.menu.connect('open-state-changed', (menu, open) => {
                if (open) {
                    // Update all sinks when menu opens
                    updateAllSinks();
                }
            });
        }
        
        // Create separator
        let separator = new PopupMenu.PopupSeparatorMenuItem();
        volumeMenu.addMenuItem(separator, 2);
        virtualSinkItems.push(separator);
        
        // Create sink items
        VIRTUAL_SINKS.forEach((sink, index) => {
            // Create the main slider item
            let item = new VirtualSinkItem(sink);
            volumeMenu.addMenuItem(item, 3 + index * 4);
            virtualSinkItems.push(item);
            virtualSinkItemsObjects.push(item);
            
            // Add the submenu selector
            let selector = item.getSinkSelector();
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
            
            // Connect submenu open event
            if (selector.menu) {
                selector.menu.connect('open-state-changed', (menu, open) => {
                    if (open) {
                        item._updateApplicationList(menu);
                    }
                });
            }
        });
        
        log('Virtual Audio Sinks: Extension enabled successfully');
        
    } catch (e) {
        log(`Virtual Audio Sinks: Error enabling extension: ${e}`);
    }
}

function disable() {
    // Disconnect menu handler
    if (menuOpenConnection) {
        let aggregateMenu = Main.panel.statusArea.aggregateMenu;
        if (aggregateMenu && aggregateMenu.menu) {
            aggregateMenu.menu.disconnect(menuOpenConnection);
        }
        menuOpenConnection = null;
    }
    
    // Destroy menu items
    virtualSinkItems.forEach(item => {
        item.destroy();
    });
    virtualSinkItems = [];
    virtualSinkItemsObjects = [];
    
    // Clean up backend
    if (backend) {
        backend.destroy();
        backend = null;
    }
    
    log('Virtual Audio Sinks: Extension disabled');
}

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        VIRTUAL_SINKS,
        VirtualSinkItem,
        enable,
        disable
    };
}