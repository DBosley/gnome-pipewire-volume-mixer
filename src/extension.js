const { Clutter, St, GObject, GLib } = imports.gi;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const Slider = imports.ui.slider;

// Check for debug mode via config file
const DEBUG_FILE = GLib.build_filenamev([GLib.get_home_dir(), '.config', 'pipewire-volume-mixer', 'debug']);
const DEBUG_MODE = GLib.file_test(DEBUG_FILE, GLib.FileTest.EXISTS);

function _debugLog(message) {
    if (DEBUG_MODE) {
        log(message);
    }
}

// Import our backends
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const DaemonBackend = Me.imports.daemonBackend.DaemonBackend;

var VIRTUAL_SINKS = [
    { name: 'Game', label: 'Game', icon: 'applications-games-symbolic' },
    { name: 'Chat', label: 'Chat', icon: 'user-available-symbolic' },
    { name: 'Media', label: 'Media', icon: 'applications-multimedia-symbolic' }
];

let volumeMenu;
let virtualSinkItems = [];
let virtualSinkItemsObjects = [];
let backend = null;
let menuOpenConnection = null;
let backendSignalIds = [];
let updateDebounceTimer = null;
const UPDATE_DEBOUNCE_MS = 100; // Batch updates within 100ms window
let lastProcessedGeneration = 0; // Track last generation to skip duplicate updates

var VirtualSinkItem = GObject.registerClass(
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
        try {
            if (!backend) return;
            
            // Update volume from backend
            let sinks = backend.getSinks();
            if (!sinks) return;
            
            let sinkInfo = sinks[this._sink.name];
            
            if (sinkInfo) {
                this._slider.block_signal_handler(this._sliderChangedId);
                this._slider.value = sinkInfo.volume;
                this._slider.unblock_signal_handler(this._sliderChangedId);
                
                this._muted = sinkInfo.muted;
                this._updateSpeakerIcon(sinkInfo.volume);
                this._slider.opacity = sinkInfo.muted ? 128 : 255;
            }
            
            // Update app list
            this._updateCurrentAppsList();
        } catch (e) {
            log(`Virtual Audio Sinks: CRITICAL ERROR in _updateFromBackend: ${e}`);
            log(`Virtual Audio Sinks: Stack trace: ${e.stack}`);
        }
    }
    
    _updateCurrentAppsList() {
        try {
            if (!backend) return;
            
            let apps = backend.getAppsForSink(this._sink.name);
            if (!apps) apps = [];
            
            this._updateAppsDisplay(apps);
        } catch (e) {
            log(`Virtual Audio Sinks: CRITICAL ERROR in _updateCurrentAppsList: ${e}`);
            log(`Virtual Audio Sinks: Stack trace: ${e.stack}`);
        }
    }
    
    _updateAppsDisplay(apps) {
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
    
    _forceRefreshApps(movingAppName, movingAppDisplayName, targetSinkName) {
        log(`Virtual Audio Sinks: _forceRefreshApps called with name=${movingAppName}, display=${movingAppDisplayName}, target=${targetSinkName}`);
        
        // Instead of parsing UI text, get the actual apps from backend
        let currentApps = backend.getAppsForSink(this._sink.name) || [];
        
        if (this._sink.name === targetSinkName) {
            // This is the destination sink - add the app if not already there
            let hasApp = currentApps.some(a => a.name === movingAppName);
            if (!hasApp) {
                // Create a fake app object for optimistic update
                currentApps.push({ 
                    name: movingAppName,
                    displayName: movingAppDisplayName,
                    active: true 
                });
            }
        } else {
            // This is not the destination - remove the app if present
            currentApps = currentApps.filter(a => a.name !== movingAppName);
        }
        
        // Update the display immediately using displayName
        this._updateAppsDisplay(currentApps);
    }
    
    _updateApplicationList(menu) {
        try {
            if (!backend) {
                menu.removeAll();
                let errorItem = new PopupMenu.PopupMenuItem('⚠️ Daemon not available', false);
                errorItem.sensitive = false;
                menu.addMenuItem(errorItem);
                return;
            }
            
            // Clear existing menu items
            menu.removeAll();
            
            // Get all apps
            let allApps = backend.getApps();
            if (!allApps) {
                let errorItem = new PopupMenu.PopupMenuItem('⚠️ No apps data available', false);
                errorItem.sensitive = false;
                menu.addMenuItem(errorItem);
                return;
            }
            
            let ourApps = backend.getAppsForSink(this._sink.name);
            if (!ourApps) ourApps = [];
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
                log(`Virtual Audio Sinks: Available app - name: ${app.name}, displayName: ${app.displayName}, active: ${app.active}, displayName type: ${typeof app.displayName}`);
                let label = app.active ? app.displayName : `[${app.displayName}]`;
                let item = new PopupMenu.PopupMenuItem(label);
                
                let isRouting = false; // Prevent multiple rapid clicks
                
                // Override the activate behavior  
                item.activate = () => {
                    if (isRouting) return;
                    isRouting = true;
                    
                    // Mark that we just routed to prevent menu rebuild
                    if (this._setLastRouteTime) {
                        this._setLastRouteTime();
                    }
                    
                    // Store destination sink for this app
                    let targetSink = this._sink.name;
                    
                    // Update all sink items immediately - optimistic UI update
                    log(`Virtual Audio Sinks: About to call _forceRefreshApps with app.name='${app.name}', app.displayName='${app.displayName}'`);
                    virtualSinkItemsObjects.forEach(sinkItem => {
                        sinkItem._forceRefreshApps(app.name, app.displayName || app.name, targetSink);
                    });
                    
                    // Remove this item from the menu optimistically
                    item.destroy();
                    
                    // Fire off the backend request after a small delay to ensure UI updates first
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                        log(`Virtual Audio Sinks: Routing ${app.name} (display: ${app.displayName}) to ${targetSink}`);
                        backend.routeApp(app.name, targetSink).then(() => {
                            // Success - no need to do anything, UI already updated
                        }).catch(e => {
                            log(`Virtual Audio Sinks: Error routing app: ${e}`);
                            // Show error to user
                            Main.notifyError('Audio Routing Failed', `Could not route ${app.displayName || app.name} to ${targetSink}`);
                            // On error, refresh from backend
                            updateAllSinks();
                        }).finally(() => {
                            isRouting = false;
                        });
                        return GLib.SOURCE_REMOVE;
                    });
                };
                
                menu.addMenuItem(item);
            });
        } else {
            let empty = new PopupMenu.PopupMenuItem('No applications to move', false);
            empty.sensitive = false;
            menu.addMenuItem(empty);
        }
        } catch (e) {
            log(`Virtual Audio Sinks: CRITICAL ERROR in _updateApplicationList: ${e}`);
            log(`Virtual Audio Sinks: Stack trace: ${e.stack}`);
            // Try to show an error in the menu
            try {
                menu.removeAll();
                let errorItem = new PopupMenu.PopupMenuItem('⚠️ Error loading apps', false);
                errorItem.sensitive = false;
                menu.addMenuItem(errorItem);
            } catch (e2) {
                log(`Virtual Audio Sinks: Failed to show error in menu: ${e2}`);
            }
        }
    }
    
    _toggleMute() {
        try {
            if (!backend) return;
            
            // Toggle mute state
            this._muted = !this._muted;
            
            // If unmuting and volume was 0, restore to saved volume
            if (!this._muted && this._slider.value === 0) {
                this._slider.value = this._mutedVolume || 0.5;
            }
            
            // Update slider visual state
            this._slider.opacity = this._muted ? 128 : 255;
            
            // Update backend
            backend.setMute(this._sink.name, this._muted).catch(e => {
                log(`Virtual Audio Sinks: Error setting mute: ${e}`);
                // Revert mute state on error
                this._muted = !this._muted;
                this._updateSpeakerIcon(this._slider.value);
                this._slider.opacity = this._muted ? 128 : 255;
            });
            
            // Update icon immediately for responsiveness
            this._updateSpeakerIcon(this._slider.value);
        } catch (e) {
            log(`Virtual Audio Sinks: CRITICAL ERROR in _toggleMute: ${e}`);
            log(`Virtual Audio Sinks: Stack trace: ${e.stack}`);
        }
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
        
        // Simply update the icon name
        if (this._speakerIcon && this._speakerIcon.child) {
            this._speakerIcon.child.icon_name = iconName;
        }
    }
    
    _sliderChanged() {
        try {
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
        } catch (e) {
            log(`Virtual Audio Sinks: CRITICAL ERROR in _sliderChanged: ${e}`);
            log(`Virtual Audio Sinks: Stack trace: ${e.stack}`);
        }
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
    try {
        if (!backend) return;
        virtualSinkItemsObjects.forEach(item => {
            try {
                item._updateFromBackend();
            } catch (e) {
                log(`Virtual Audio Sinks: Error updating sink item: ${e}`);
            }
        });
    } catch (e) {
        log(`Virtual Audio Sinks: CRITICAL ERROR in updateAllSinks: ${e}`);
        log(`Virtual Audio Sinks: Stack trace: ${e.stack}`);
    }
}

// Debounced version of updateAllSinks to batch rapid updates
function debouncedUpdateAllSinks() {
    // Clear any pending update
    if (updateDebounceTimer) {
        GLib.source_remove(updateDebounceTimer);
        updateDebounceTimer = null;
    }
    
    // Schedule update after debounce period
    updateDebounceTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, UPDATE_DEBOUNCE_MS, () => {
        updateDebounceTimer = null;
        updateAllSinks();
        return GLib.SOURCE_REMOVE;
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
    
    // Connect to backend signals for live updates
    if (backend && backend._dbusBackend) {
        const appRoutedCallback = (appName, sinkName) => {
            log(`Virtual Audio Sinks: App ${appName} routed to ${sinkName}, updating UI`);
            // Don't update if menu is closed - we'll refresh when it opens
            let aggregateMenu = Main.panel.statusArea.aggregateMenu;
            if (aggregateMenu && aggregateMenu.menu && aggregateMenu.menu.isOpen) {
                debouncedUpdateAllSinks();
            }
        };
        backend._dbusBackend.connect('applicationRouted', appRoutedCallback);
        backendSignalIds.push({
            signal: 'applicationRouted',
            callback: appRoutedCallback
        });
        
        const stateChangedCallback = (generation) => {
            log(`Virtual Audio Sinks: State changed (generation ${generation}), updating UI`);
            
            // Skip if we've already processed this generation
            if (generation && generation <= lastProcessedGeneration) {
                log(`Virtual Audio Sinks: Skipping duplicate update for generation ${generation}`);
                return;
            }
            
            if (generation) {
                lastProcessedGeneration = generation;
            }
            
            // Don't update if menu is closed - we'll refresh when it opens
            let aggregateMenu = Main.panel.statusArea.aggregateMenu;
            if (aggregateMenu && aggregateMenu.menu && aggregateMenu.menu.isOpen) {
                debouncedUpdateAllSinks();
            }
        };
        backend._dbusBackend.connect('stateChanged', stateChangedCallback);
        backendSignalIds.push({
            signal: 'stateChanged', 
            callback: stateChangedCallback
        });
        
        const appsChangedCallback = (added, removed) => {
            log(`Virtual Audio Sinks: Apps changed (added: ${added}, removed: ${removed}), updating UI`);
            // Don't update if menu is closed - we'll refresh when it opens
            let aggregateMenu = Main.panel.statusArea.aggregateMenu;
            if (aggregateMenu && aggregateMenu.menu && aggregateMenu.menu.isOpen) {
                debouncedUpdateAllSinks();
            }
        };
        backend._dbusBackend.connect('applicationsChanged', appsChangedCallback);
        backendSignalIds.push({
            signal: 'applicationsChanged',
            callback: appsChangedCallback
        });
    }
    
    try {
        volumeMenu = Main.panel.statusArea.aggregateMenu._volume._volumeMenu;
        
        // Connect to menu opening to refresh data
        let aggregateMenu = Main.panel.statusArea.aggregateMenu;
        if (aggregateMenu && aggregateMenu.menu) {
            menuOpenConnection = aggregateMenu.menu.connect('open-state-changed', (menu, open) => {
                try {
                    if (open) {
                        // Force refresh from backend to get current state
                        log('Virtual Audio Sinks: Menu opened, refreshing from backend');
                        if (backend && backend._dbusBackend) {
                            // Force the daemon to refresh and then reload our state
                            backend._dbusBackend.refreshState().then(() => {
                                let apps = backend.getApps();
                                log(`Virtual Audio Sinks: Apps after refresh: ${JSON.stringify(apps)}`);
                                updateAllSinks();
                            });
                        } else {
                            // No refresh needed, just update
                            updateAllSinks();
                        }
                    }
                } catch (e) {
                    log(`Virtual Audio Sinks: CRITICAL ERROR in menu open handler: ${e}`);
                    log(`Virtual Audio Sinks: Stack trace: ${e.stack}`);
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
                let lastRouteTime = 0;
                selector.menu.connect('open-state-changed', (menu, open) => {
                    try {
                        if (open) {
                            // Don't rebuild if we just routed an app (within 500ms)
                            let now = Date.now();
                            if (now - lastRouteTime > 500) {
                                item._updateApplicationList(menu);
                            }
                        }
                    } catch (e) {
                        log(`Virtual Audio Sinks: CRITICAL ERROR in submenu open handler: ${e}`);
                        log(`Virtual Audio Sinks: Stack trace: ${e.stack}`);
                    }
                });
                
                // Store reference to update last route time
                item._setLastRouteTime = () => {
                    lastRouteTime = Date.now();
                };
            }
        });
        
        log('Virtual Audio Sinks: Extension enabled successfully');
        
    } catch (e) {
        log(`Virtual Audio Sinks: Error enabling extension: ${e}`);
    }
}

function disable() {
    // Clear any pending debounced updates
    if (updateDebounceTimer) {
        GLib.source_remove(updateDebounceTimer);
        updateDebounceTimer = null;
    }
    
    // Disconnect menu handler
    if (menuOpenConnection) {
        let aggregateMenu = Main.panel.statusArea.aggregateMenu;
        if (aggregateMenu && aggregateMenu.menu) {
            aggregateMenu.menu.disconnect(menuOpenConnection);
        }
        menuOpenConnection = null;
    }
    
    // Disconnect backend signals
    if (backend && backend._dbusBackend) {
        backendSignalIds.forEach(({ signal, callback }) => {
            backend._dbusBackend.disconnect(signal, callback);
        });
    }
    backendSignalIds = [];
    
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