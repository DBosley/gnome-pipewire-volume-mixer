const { Gio, GLib } = imports.gi;

const DBUS_NAME = 'org.gnome.PipewireVolumeMixer';
const DBUS_PATH = '/org/gnome/PipewireVolumeMixer';
const DBUS_INTERFACE = 'org.gnome.PipewireVolumeMixer';

// Check for debug mode via config file
const DEBUG_FILE = GLib.build_filenamev([GLib.get_home_dir(), '.config', 'pipewire-volume-mixer', 'debug']);
const DEBUG_MODE = GLib.file_test(DEBUG_FILE, GLib.FileTest.EXISTS);

function debugLog(message) {
    if (DEBUG_MODE) {
        log(message);
    }
}

// D-Bus interface XML
const _interfaceXml = `
<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN"
"http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">
<node>
  <interface name="${DBUS_INTERFACE}">
    <property name="Sinks" type="a{sv}" access="read"/>
    <property name="Applications" type="a{sv}" access="read"/>
    <property name="Generation" type="u" access="read"/>
    <property name="LastUpdate" type="u" access="read"/>
    
    <method name="SetSinkVolume">
      <arg name="sink_name" type="s" direction="in"/>
      <arg name="volume" type="d" direction="in"/>
      <arg name="success" type="b" direction="out"/>
    </method>
    
    <method name="SetSinkMute">
      <arg name="sink_name" type="s" direction="in"/>
      <arg name="muted" type="b" direction="in"/>
      <arg name="success" type="b" direction="out"/>
    </method>
    
    <method name="RouteApplication">
      <arg name="app_name" type="s" direction="in"/>
      <arg name="sink_name" type="s" direction="in"/>
      <arg name="success" type="b" direction="out"/>
    </method>
    
    <method name="RefreshState"/>
    
    <method name="GetFullState">
      <arg name="state" type="a{sv}" direction="out"/>
    </method>
    
    <signal name="StateChanged">
      <arg name="generation" type="u"/>
    </signal>
    
    <signal name="SinkVolumeChanged">
      <arg name="sink_name" type="s"/>
      <arg name="volume" type="d"/>
    </signal>
    
    <signal name="SinkMuteChanged">
      <arg name="sink_name" type="s"/>
      <arg name="muted" type="b"/>
    </signal>
    
    <signal name="ApplicationRouted">
      <arg name="app_name" type="s"/>
      <arg name="sink_name" type="s"/>
    </signal>
    
    <signal name="ApplicationsChanged">
      <arg name="added" type="as"/>
      <arg name="removed" type="as"/>
    </signal>
  </interface>
</node>`;

var DBusBackend = class DBusBackend {
    constructor() {
        this._proxy = null;
        this._available = false;
        this._cache = {
            sinks: {},
            apps: {},
            generation: 0,
            lastUpdate: 0
        };
        this._signalIds = [];
        this._callbacks = {
            stateChanged: [],
            sinkVolumeChanged: [],
            sinkMuteChanged: [],
            applicationRouted: [],
            applicationsChanged: []
        };
        this._reconnectAttempts = 0;
        this._reconnectTimer = null;
        this._maxReconnectAttempts = 10;
        this._reconnectBaseDelay = 1000; // 1 second
        
        if (DEBUG_MODE) {
            log('Virtual Audio Sinks: Debug mode enabled (PIPEWIRE_MIXER_DEBUG=1)');
        }
        
        // Try initial connection
        this._tryConnect();
    }
    
    _tryConnect() {
        try {
            this._proxy = new Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SESSION,
                Gio.DBusProxyFlags.NONE,
                null,
                DBUS_NAME,
                DBUS_PATH,
                DBUS_INTERFACE,
                null
            );
            
            // Watch for daemon disconnection
            this._proxy.connect('notify::g-name-owner', () => {
                if (!this._proxy.g_name_owner) {
                    log('Virtual Audio Sinks: D-Bus service disconnected');
                    this._handleDisconnection();
                }
            });
            
            this._available = true;
            this._reconnectAttempts = 0;
            debugLog('Virtual Audio Sinks: D-Bus backend connected, connecting signals...');
            this._connectSignals();
            debugLog('Virtual Audio Sinks: Loading initial state...');
            this._loadInitialState();
            log('Virtual Audio Sinks: D-Bus backend connected successfully');
        } catch (e) {
            log(`Virtual Audio Sinks: Failed to connect to D-Bus service: ${e}`);
            this._available = false;
            this._scheduleReconnect();
        }
    }
    
    _handleDisconnection() {
        this._available = false;
        this._disconnectSignals();
        this._proxy = null;
        this._scheduleReconnect();
    }
    
    _scheduleReconnect() {
        if (this._reconnectTimer) {
            return; // Already scheduled
        }
        
        if (this._reconnectAttempts >= this._maxReconnectAttempts) {
            log(`Virtual Audio Sinks: Max reconnection attempts (${this._maxReconnectAttempts}) reached`);
            return;
        }
        
        this._reconnectAttempts++;
        const delay = Math.min(this._reconnectBaseDelay * Math.pow(2, this._reconnectAttempts - 1), 30000);
        
        log(`Virtual Audio Sinks: Scheduling reconnection attempt ${this._reconnectAttempts} in ${delay}ms`);
        
        this._reconnectTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._reconnectTimer = null;
            log(`Virtual Audio Sinks: Attempting to reconnect (attempt ${this._reconnectAttempts})`);
            this._tryConnect();
            return GLib.SOURCE_REMOVE;
        });
    }
    
    _disconnectSignals() {
        this._signalIds.forEach(id => {
            if (this._proxy) {
                this._proxy.disconnect(id);
            }
        });
        this._signalIds = [];
    }
    
    _connectSignals() {
        if (!this._proxy) return;
        
        debugLog('Virtual Audio Sinks: Connecting to D-Bus signals');
        
        // Connect to property changes for cached properties
        this._signalIds.push(
            this._proxy.connect('g-properties-changed', (proxy, changed, _invalidated) => {
                debugLog('Virtual Audio Sinks: D-Bus properties changed');
                this._onPropertiesChanged(changed.deep_unpack());
            })
        );
        
        // Connect to custom signals
        this._signalIds.push(
            this._proxy.connectSignal('StateChanged', (proxy, sender, params) => {
                const [generation] = params.deep_unpack();
                this._cache.generation = generation;
                this._emitCallbacks('stateChanged', generation);
            })
        );
        
        this._signalIds.push(
            this._proxy.connectSignal('SinkVolumeChanged', (proxy, sender, params) => {
                const [sinkName, volume] = params.deep_unpack();
                if (this._cache.sinks[sinkName]) {
                    this._cache.sinks[sinkName].volume = volume;
                }
                this._emitCallbacks('sinkVolumeChanged', sinkName, volume);
            })
        );
        
        this._signalIds.push(
            this._proxy.connectSignal('SinkMuteChanged', (proxy, sender, params) => {
                const [sinkName, muted] = params.deep_unpack();
                if (this._cache.sinks[sinkName]) {
                    this._cache.sinks[sinkName].muted = muted;
                }
                this._emitCallbacks('sinkMuteChanged', sinkName, muted);
            })
        );
        
        this._signalIds.push(
            this._proxy.connectSignal('ApplicationRouted', (proxy, sender, params) => {
                const [appName, sinkName] = params.deep_unpack();
                log(`Virtual Audio Sinks: D-Bus ApplicationRouted signal received: ${appName} -> ${sinkName}`);
                if (this._cache.apps[appName]) {
                    this._cache.apps[appName].currentSink = sinkName;
                }
                this._emitCallbacks('applicationRouted', appName, sinkName);
            })
        );
        
        this._signalIds.push(
            this._proxy.connectSignal('ApplicationsChanged', (proxy, sender, params) => {
                const [added, removed] = params.deep_unpack();
                // Update cache
                for (const appName of removed) {
                    delete this._cache.apps[appName];
                }
                this._emitCallbacks('applicationsChanged', added, removed);
            })
        );
    }
    
    _onPropertiesChanged(changed) {
        if ('Sinks' in changed) {
            this._cache.sinks = this._unpackSinks(changed.Sinks);
        }
        if ('Applications' in changed) {
            this._cache.apps = this._unpackApplications(changed.Applications);
        }
        if ('Generation' in changed) {
            this._cache.generation = changed.Generation;
        }
        if ('LastUpdate' in changed) {
            this._cache.lastUpdate = changed.LastUpdate;
        }
    }
    
    _loadInitialState() {
        if (!this._proxy) return;
        
        debugLog('Virtual Audio Sinks: _loadInitialState called');
        
        // Load cached properties from D-Bus proxy
        try {
            const sinks = this._proxy.get_cached_property('Sinks');
            if (sinks) {
                this._cache.sinks = this._unpackSinks(sinks.deep_unpack());
            }
            
            const apps = this._proxy.get_cached_property('Applications');
            debugLog(`Virtual Audio Sinks: Loading apps from D-Bus...`);
            if (apps) {
                this._cache.apps = this._unpackApplications(apps.deep_unpack());
                debugLog(`Virtual Audio Sinks: Loaded ${Object.keys(this._cache.apps).length} apps`);
            }
            
            const generation = this._proxy.get_cached_property('Generation');
            if (generation) {
                this._cache.generation = generation.deep_unpack();
            }
            
            const lastUpdate = this._proxy.get_cached_property('LastUpdate');
            if (lastUpdate) {
                this._cache.lastUpdate = lastUpdate.deep_unpack();
            }
        } catch (e) {
            log(`Virtual Audio Sinks: Failed to load initial state: ${e}`);
        }
    }
    
    _unpackSinks(variant) {
        const sinks = {};
        const sinksDict = variant;
        
        // Helper to safely get values from GVariants
        const getValue = (data, key, defaultValue) => {
            if (!data || !data[key]) return defaultValue;
            const val = data[key];
            // If it's already a primitive, return it; otherwise deep_unpack
            return (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') 
                ? val : val.deep_unpack();
        };
        
        for (const sinkName in sinksDict) {
            if (!Object.prototype.hasOwnProperty.call(sinksDict, sinkName)) continue;
            const sinkData = sinksDict[sinkName];
            sinks[sinkName] = {
                name: sinkName,
                pipewireId: getValue(sinkData, 'pipewire_id', 0),
                volume: getValue(sinkData, 'volume', 0.75),
                muted: getValue(sinkData, 'muted', false)
            };
        }
        
        return sinks;
    }
    
    _unpackApplications(variant) {
        const apps = {};
        const appsDict = variant;
        
        // Only process own properties, not inherited ones
        for (const appName in appsDict) {
            if (!Object.prototype.hasOwnProperty.call(appsDict, appName)) continue;
            
            const appData = appsDict[appName];
            // Handle GVariant unpacking - values might be GVariants that need deep_unpack()
            const getValue = (data, key, defaultValue) => {
                if (!data || !data[key]) return defaultValue;
                const val = data[key];
                // If it's already a primitive, return it; otherwise deep_unpack
                return (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') 
                    ? val : val.deep_unpack();
            };
            
            const currentSink = getValue(appData, 'current_sink', '');
            const displayName = getValue(appData, 'display_name', appName);
            
            // Debug logging
            debugLog(`Virtual Audio Sinks: Unpacking app ${appName}: displayName='${displayName}', currentSink='${currentSink}'`);
            
            apps[appName] = {
                name: appName,
                displayName: displayName,
                currentSink: currentSink,
                pipewireId: getValue(appData, 'pipewire_id', 0),
                active: getValue(appData, 'active', false)
            };
        }
        
        return apps;
    }
    
    // Public API matching the old backend interface
    isAvailable() {
        return this._available;
    }
    
    getSinks() {
        return this._cache.sinks;
    }
    
    getApps() {
        return this._cache.apps;
    }
    
    getAppsForSink(sinkName) {
        const apps = [];
        debugLog(`Virtual Audio Sinks: getAppsForSink(${sinkName}) - checking apps...`);
        for (const appName in this._cache.apps) {
            const app = this._cache.apps[appName];
            debugLog(`Virtual Audio Sinks:   App ${appName}: currentSink='${app.currentSink}', matches=${app.currentSink === sinkName}`);
            if (app.currentSink === sinkName) {
                apps.push(app);
            }
        }
        debugLog(`Virtual Audio Sinks: getAppsForSink(${sinkName}) returning ${apps.length} apps`);
        return apps;
    }
    
    setSinkVolume(sinkName, volume) {
        return new Promise((resolve, reject) => {
            if (!this._proxy) {
                reject(new Error('D-Bus proxy not available'));
                return;
            }
            
            // Optimistically update cache
            if (this._cache.sinks[sinkName]) {
                this._cache.sinks[sinkName].volume = volume;
            }
            
            // Call D-Bus method asynchronously
            this._proxy.call(
                'SetSinkVolume',
                new GLib.Variant('(sd)', [sinkName, volume]),
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (obj, res) => {
                    try {
                        const [success] = this._proxy.call_finish(res).deep_unpack();
                        if (!success) {
                            log(`Virtual Audio Sinks: Failed to set volume for ${sinkName}`);
                            // Reload state on failure
                            this.refreshState();
                            reject(new Error(`Failed to set volume for ${sinkName}`));
                        } else {
                            resolve(true);
                        }
                    } catch (e) {
                        log(`Virtual Audio Sinks: Error setting volume: ${e}`);
                        reject(e);
                    }
                }
            );
        });
    }
    
    setSinkMute(sinkName, muted) {
        return new Promise((resolve, reject) => {
            if (!this._proxy) {
                reject(new Error('D-Bus proxy not available'));
                return;
            }
            
            // Optimistically update cache
            if (this._cache.sinks[sinkName]) {
                this._cache.sinks[sinkName].muted = muted;
            }
            
            // Call D-Bus method asynchronously
            this._proxy.call(
                'SetSinkMute',
                new GLib.Variant('(sb)', [sinkName, muted]),
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (obj, res) => {
                    try {
                        const [success] = this._proxy.call_finish(res).deep_unpack();
                        if (!success) {
                            log(`Virtual Audio Sinks: Failed to set mute for ${sinkName}`);
                            // Reload state on failure
                            this.refreshState();
                            reject(new Error(`Failed to set mute for ${sinkName}`));
                        } else {
                            resolve(true);
                        }
                    } catch (e) {
                        log(`Virtual Audio Sinks: Error setting mute: ${e}`);
                        reject(e);
                    }
                }
            );
        });
    }
    
    routeApp(appName, sinkName) {
        if (!this._proxy) return Promise.reject(new Error('No D-Bus proxy available'));
        
        return new Promise((resolve, reject) => {
            // Call D-Bus method
            this._proxy.call(
                'RouteApplication',
                new GLib.Variant('(ss)', [appName, sinkName]),
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (proxy, res) => {
                    try {
                        const result = this._proxy.call_finish(res);
                        const [success] = result.deep_unpack();
                        if (!success) {
                            log(`Virtual Audio Sinks: Failed to route ${appName} to ${sinkName}`);
                            reject(new Error(`Failed to route ${appName} to ${sinkName}`));
                        } else {
                            // Always refresh after routing
                            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                                this.refreshState();
                                return GLib.SOURCE_REMOVE;
                            });
                            resolve(true);
                        }
                    } catch (e) {
                        log(`Virtual Audio Sinks: Error routing app: ${e}`);
                        reject(e);
                    }
                }
            );
        });
    }
    
    refreshState() {
        if (!this._proxy) return Promise.resolve();
        
        debugLog('Virtual Audio Sinks: refreshState called, getting fresh state from D-Bus');
        
        return new Promise((resolve) => {
            // Call GetFullState to get fresh data bypassing cache
            this._proxy.call(
                'GetFullState',
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (proxy, res) => {
                    try {
                        debugLog('Virtual Audio Sinks: About to call_finish...');
                        const result = this._proxy.call_finish(res);
                        debugLog('Virtual Audio Sinks: call_finish succeeded, unpacking...');
                        const [state] = result.deep_unpack();
                        
                        debugLog('Virtual Audio Sinks: Got fresh state from GetFullState');
                        debugLog(`Virtual Audio Sinks: State type: ${typeof state}`);
                        
                        if (state && typeof state === 'object') {
                            debugLog(`Virtual Audio Sinks: State keys: ${Object.keys(state).join(', ')}`);
                            
                            // Update cache with fresh data (keys are lowercase from daemon)
                            if (state.sinks) {
                                debugLog(`Virtual Audio Sinks: Found sinks data, type: ${typeof state.sinks}`);
                                let sinksData = state.sinks;
                                if (sinksData.deep_unpack) {
                                    debugLog('Virtual Audio Sinks: Sinks is a GVariant, unpacking...');
                                    sinksData = sinksData.deep_unpack();
                                }
                                this._cache.sinks = this._unpackSinks(sinksData);
                            } else {
                                debugLog('Virtual Audio Sinks: No sinks in state');
                            }
                            
                            if (state.applications) {
                                debugLog(`Virtual Audio Sinks: Found applications data, type: ${typeof state.applications}`);
                                // Check if it's a GVariant that needs unpacking
                                let appsData = state.applications;
                                if (appsData.deep_unpack) {
                                    debugLog('Virtual Audio Sinks: Applications is a GVariant, unpacking...');
                                    appsData = appsData.deep_unpack();
                                }
                                debugLog(`Virtual Audio Sinks: Applications keys after unpack: ${Object.keys(appsData).join(', ')}`);
                                this._cache.apps = this._unpackApplications(appsData);
                                debugLog(`Virtual Audio Sinks: Refreshed ${Object.keys(this._cache.apps).length} apps from GetFullState`);
                            } else {
                                debugLog('Virtual Audio Sinks: No applications in state');
                            }
                            
                            if (state.generation) {
                                this._cache.generation = state.generation;
                            }
                            if (state.last_update) {
                                this._cache.lastUpdate = state.last_update;
                            }
                        } else {
                            debugLog(`Virtual Audio Sinks: Invalid state received: ${state}`);
                        }
                        
                        resolve();
                    } catch (e) {
                        log(`Virtual Audio Sinks: Error refreshing state: ${e}`);
                        log(`Virtual Audio Sinks: Error stack: ${e.stack}`);
                        resolve(); // Still resolve even on error
                    }
                }
            );
        });
    }
    
    // Callback management
    connect(signal, callback) {
        if (this._callbacks[signal]) {
            this._callbacks[signal].push(callback);
        }
    }
    
    disconnect(signal, callback) {
        if (this._callbacks[signal]) {
            const index = this._callbacks[signal].indexOf(callback);
            if (index > -1) {
                this._callbacks[signal].splice(index, 1);
            }
        }
    }
    
    _emitCallbacks(signal, ...args) {
        if (this._callbacks[signal]) {
            for (const callback of this._callbacks[signal]) {
                try {
                    callback(...args);
                } catch (e) {
                    log(`Virtual Audio Sinks: Error in callback for ${signal}: ${e}`);
                }
            }
        }
    }
    
    destroy() {
        // Cancel any pending reconnection
        if (this._reconnectTimer) {
            GLib.source_remove(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        
        // Disconnect all signals
        for (const id of this._signalIds) {
            if (this._proxy) {
                this._proxy.disconnect(id);
            }
        }
        this._signalIds = [];
        
        // Clear callbacks
        for (const signal in this._callbacks) {
            this._callbacks[signal] = [];
        }
        
        this._proxy = null;
        this._available = false;
    }
};

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DBusBackend };
}