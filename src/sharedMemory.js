const { Gio, GLib } = imports.gi;

// Shared memory reader for the GNOME Shell extension
var SharedMemoryReader = class SharedMemoryReader {
    constructor() {
        this._userId = GLib.get_user_runtime_dir().split('/').pop();
        this._shmPath = `/dev/shm/pipewire-volume-mixer-${this._userId}`;
        this._generation = 0n;
        this._lastRead = 0;
        this._cache = null;
    }

    // Check if daemon is available
    isDaemonAvailable() {
        try {
            let file = Gio.File.new_for_path(this._shmPath);
            return file.query_exists(null);
        } catch (_e) {
            return false;
        }
    }

    // Read cache from shared memory
    readCache() {
        try {
            // Rate limit reads
            let now = Date.now();
            if (this._cache && (now - this._lastRead) < 50) {
                return this._cache;
            }
            this._lastRead = now;

            let file = Gio.File.new_for_path(this._shmPath);
            let [success, contents] = file.load_contents(null);
            
            if (!success || !contents || contents.length < 32) {
                log('Virtual Audio Sinks: Invalid shared memory contents');
                return null;
            }

            // Create a DataView for the binary data
            let buffer = new ArrayBuffer(contents.length);
            let view = new Uint8Array(buffer);
            for (let i = 0; i < contents.length; i++) {
                view[i] = contents[i];
            }
            let dataView = new DataView(buffer);
            
            let offset = 0;
            
            // Read header
            let version = dataView.getUint32(offset, true); 
            offset += 4;
            
            if (version !== 1) {
                log(`Virtual Audio Sinks: Unknown cache version: ${version}`);
                return null;
            }
            
            // Read generation (8 bytes as two 32-bit values for GJS compatibility)
            let genLow = dataView.getUint32(offset, true);
            let genHigh = dataView.getUint32(offset + 4, true);
            let generation = genLow + (genHigh * 0x100000000);
            offset += 8;
            
            // Skip if unchanged
            if (generation === this._generation) {
                return this._cache;
            }
            
            this._generation = generation;
            
            // Skip timestamp and reserved
            offset += 20;
            
            // Read sinks
            let sinkCount = dataView.getUint32(offset, true);
            offset += 4;
            
            let sinks = {};
            for (let i = 0; i < sinkCount && offset < buffer.byteLength; i++) {
                let nameLen = view[offset];
                offset += 1;
                
                if (offset + nameLen > buffer.byteLength) break;
                
                let nameBytes = new Uint8Array(buffer, offset, nameLen);
                let name = String.fromCharCode.apply(null, nameBytes);
                offset += nameLen;
                
                if (offset + 9 > buffer.byteLength) break;
                
                sinks[name] = {
                    id: dataView.getUint32(offset, true),
                    volume: dataView.getFloat32(offset + 4, true),
                    muted: view[offset + 8] === 1
                };
                offset += 9;
            }
            
            // Read apps
            let appCount = dataView.getUint32(offset, true);
            offset += 4;
            
            let apps = {};
            for (let i = 0; i < appCount && offset < buffer.byteLength; i++) {
                // App name
                let nameLen = view[offset];
                offset += 1;
                
                if (offset + nameLen > buffer.byteLength) break;
                
                let nameBytes = new Uint8Array(buffer, offset, nameLen);
                let name = String.fromCharCode.apply(null, nameBytes);
                offset += nameLen;
                
                // Sink name
                let sinkLen = view[offset];
                offset += 1;
                
                if (offset + sinkLen > buffer.byteLength) break;
                
                let sinkBytes = new Uint8Array(buffer, offset, sinkLen);
                let sinkName = String.fromCharCode.apply(null, sinkBytes);
                offset += sinkLen;
                
                if (offset + 1 > buffer.byteLength) break;
                
                // Active flag
                let active = view[offset] === 1;
                offset += 1;
                
                apps[name] = {
                    displayName: name,
                    currentSink: sinkName,
                    active: active
                };
            }
            
            this._cache = { 
                sinks: sinks, 
                apps: apps, 
                generation: generation,
                timestamp: now
            };
            
            return this._cache;
            
        } catch (e) {
            log(`Virtual Audio Sinks: Failed to read shared memory: ${e}`);
            return null;
        }
    }

    destroy() {
        this._cache = null;
    }
}

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SharedMemoryReader };
}