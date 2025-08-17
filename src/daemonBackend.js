const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const DBusBackend = Me.imports.dbusBackend;

// Daemon backend that uses D-Bus for all communication
var DaemonBackend = class DaemonBackend {
    constructor() {
        this._dbusBackend = new DBusBackend.DBusBackend();
        this._available = false;
        this._lastAvailabilityCheck = 0;
    }

    // Check if daemon is available (cached for 5 seconds)
    isDaemonAvailable() {
        let now = Date.now();
        if (now - this._lastAvailabilityCheck < 5000) {
            return this._available;
        }

        this._lastAvailabilityCheck = now;
        this._available = this._dbusBackend.isAvailable();
        
        if (!this._available) {
            log('Virtual Audio Sinks: Daemon not available');
        }
        
        return this._available;
    }

    // Get current cache data
    getCache() {
        if (!this.isDaemonAvailable()) {
            return null;
        }

        return {
            sinks: this._dbusBackend.getSinks(),
            apps: this._dbusBackend.getApps()
        };
    }

    // Get all virtual sinks
    getSinks() {
        if (!this.isDaemonAvailable()) {
            return {};
        }
        return this._dbusBackend.getSinks();
    }

    // Get all apps
    getApps() {
        if (!this.isDaemonAvailable()) {
            return {};
        }
        return this._dbusBackend.getApps();
    }

    // Get apps for a specific sink
    getAppsForSink(sinkName) {
        if (!this.isDaemonAvailable()) {
            return [];
        }
        return this._dbusBackend.getAppsForSink(sinkName);
    }

    // Route an app to a sink
    routeApp(appName, sinkName) {
        if (!this.isDaemonAvailable()) {
            log('Virtual Audio Sinks: Daemon not available for routing');
            return Promise.reject(new Error('Daemon not available'));
        }

        return this._dbusBackend.routeApp(appName, sinkName);
    }

    // Set volume for a sink
    setVolume(sinkName, volume) {
        if (!this.isDaemonAvailable()) {
            log('Virtual Audio Sinks: Daemon not available for volume change');
            return Promise.reject(new Error('Daemon not available'));
        }

        return this._dbusBackend.setSinkVolume(sinkName, volume);
    }

    // Set mute state for a sink
    setMute(sinkName, muted) {
        if (!this.isDaemonAvailable()) {
            log('Virtual Audio Sinks: Daemon not available for mute change');
            return Promise.reject(new Error('Daemon not available'));
        }

        return this._dbusBackend.setSinkMute(sinkName, muted);
    }

    // Clean up
    destroy() {
        if (this._dbusBackend) {
            this._dbusBackend.destroy();
            this._dbusBackend = null;
        }
    }
};

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DaemonBackend };
}