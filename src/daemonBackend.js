const { GLib } = imports.gi;

// Import our modules
const SharedMemory = imports.misc.extensionUtils.getCurrentExtension().imports.sharedMemory;
const IpcClient = imports.misc.extensionUtils.getCurrentExtension().imports.ipcClient;

// Daemon backend that uses shared memory for reads and IPC for writes
var DaemonBackend = class DaemonBackend {
    constructor() {
        this._sharedMemory = new SharedMemory.SharedMemoryReader();
        this._ipcClient = new IpcClient.IpcClient();
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
        this._available = this._sharedMemory.isDaemonAvailable();
        
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

        return this._sharedMemory.readCache();
    }

    // Get all virtual sinks
    getSinks() {
        let cache = this.getCache();
        if (!cache || !cache.sinks) {
            return {};
        }
        return cache.sinks;
    }

    // Get all apps
    getApps() {
        let cache = this.getCache();
        if (!cache || !cache.apps) {
            return {};
        }
        return cache.apps;
    }

    // Get apps for a specific sink
    getAppsForSink(sinkName) {
        let apps = this.getApps();
        return Object.entries(apps)
            .filter(([_, app]) => app.currentSink === sinkName)
            .map(([name, app]) => ({
                name: name,
                displayName: app.displayName,
                active: app.active
            }));
    }

    // Route an app to a sink
    async routeApp(appName, sinkName) {
        if (!this.isDaemonAvailable()) {
            throw new Error('Daemon not available');
        }

        try {
            await this._ipcClient.routeApp(appName, sinkName);
            // Give daemon time to update cache
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                this._sharedMemory.readCache(); // Force cache refresh
                return GLib.SOURCE_REMOVE;
            });
        } catch (e) {
            log(`Virtual Audio Sinks: Failed to route app: ${e}`);
            throw e;
        }
    }

    // Set volume for a sink
    async setVolume(sinkName, volume) {
        if (!this.isDaemonAvailable()) {
            throw new Error('Daemon not available');
        }

        try {
            await this._ipcClient.setVolume(sinkName, volume);
        } catch (e) {
            log(`Virtual Audio Sinks: Failed to set volume: ${e}`);
            throw e;
        }
    }

    // Set mute state for a sink
    async setMute(sinkName, muted) {
        if (!this.isDaemonAvailable()) {
            throw new Error('Daemon not available');
        }

        try {
            await this._ipcClient.setMute(sinkName, muted);
        } catch (e) {
            log(`Virtual Audio Sinks: Failed to set mute: ${e}`);
            throw e;
        }
    }

    // Clean up
    destroy() {
        if (this._sharedMemory) {
            this._sharedMemory.destroy();
            this._sharedMemory = null;
        }
        this._ipcClient = null;
    }
}

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DaemonBackend };
}