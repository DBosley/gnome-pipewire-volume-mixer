#!/usr/bin/env gjs

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;

// Read shared memory
const uid = GLib.getenv('UID') || '1000';
const shmPath = `/dev/shm/pipewire-volume-mixer-${uid}`;
const file = Gio.File.new_for_path(shmPath);

try {
    const [success, contents] = file.load_contents(null);
    if (success) {
        // Read binary header
        const view = new DataView(contents.buffer);
        const version = view.getUint32(0, true);
        const generation = Number(view.getBigUint64(4, true));
        const timestamp = Number(view.getBigUint64(12, true));
        
        print(`Version: ${version}`);
        print(`Generation: ${generation}`);
        print(`Timestamp: ${new Date(timestamp)}`);
        
        // Skip to data section (32 bytes header)
        let offset = 32;
        
        // Read sinks
        const sinkCount = view.getUint32(offset, true);
        offset += 4;
        print(`\nSinks (${sinkCount}):`);
        
        for (let i = 0; i < sinkCount; i++) {
            const nameLen = view.getUint8(offset);
            offset += 1;
            
            let name = '';
            for (let j = 0; j < nameLen; j++) {
                name += String.fromCharCode(view.getUint8(offset + j));
            }
            offset += nameLen;
            
            const id = view.getUint32(offset, true);
            offset += 4;
            
            const volume = view.getFloat32(offset, true);
            offset += 4;
            
            const muted = view.getUint8(offset) === 1;
            offset += 1;
            
            print(`  ${name}: id=${id}, volume=${volume.toFixed(2)}, muted=${muted}`);
        }
        
        // Read apps
        const appCount = view.getUint32(offset, true);
        offset += 4;
        print(`\nApps (${appCount}):`);
        
        for (let i = 0; i < appCount; i++) {
            // App name
            const nameLen = view.getUint8(offset);
            offset += 1;
            
            let name = '';
            for (let j = 0; j < nameLen; j++) {
                name += String.fromCharCode(view.getUint8(offset + j));
            }
            offset += nameLen;
            
            // Current sink
            const sinkLen = view.getUint8(offset);
            offset += 1;
            
            let currentSink = '';
            for (let j = 0; j < sinkLen; j++) {
                currentSink += String.fromCharCode(view.getUint8(offset + j));
            }
            offset += sinkLen;
            
            // Active flag
            const active = view.getUint8(offset) === 1;
            offset += 1;
            
            print(`  ${name}: sink="${currentSink}", active=${active}`);
        }
    } else {
        print("Failed to read shared memory file");
    }
} catch (e) {
    print(`Error: ${e}`);
}