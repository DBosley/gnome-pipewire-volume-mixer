const { Gio, GLib } = imports.gi;

// IPC client for communicating with the daemon
var IpcClient = class IpcClient {
    constructor() {
        this._userId = GLib.get_user_runtime_dir().split('/').pop();
        this._socketPath = `/run/user/${this._userId}/pipewire-volume-mixer.sock`;
    }

    // Check if daemon socket exists
    isAvailable() {
        try {
            let file = Gio.File.new_for_path(this._socketPath);
            return file.query_exists(null);
        } catch (_e) {
            return false;
        }
    }

    // Send a command to the daemon
    async sendCommand(command) {
        return new Promise((resolve, reject) => {
            try {
                let client = new Gio.SocketClient();
                let socketAddress = new Gio.UnixSocketAddress({ path: this._socketPath });
                let connection = client.connect(socketAddress, null);
                
                if (!connection) {
                    reject(new Error('Failed to connect to daemon'));
                    return;
                }

                // Send command
                let output = connection.get_output_stream();
                let bytes = GLib.Bytes.new((command + '\n').split('').map(c => c.charCodeAt(0)));
                output.write_bytes(bytes, null);

                // Read response
                let input = connection.get_input_stream();
                let dataInput = Gio.DataInputStream.new(input);
                let [line, _length] = dataInput.read_line_utf8(null);
                
                connection.close(null);

                if (!line) {
                    reject(new Error('No response from daemon'));
                    return;
                }

                if (line.startsWith('OK')) {
                    resolve(line.substring(3));
                } else if (line.startsWith('ERROR')) {
                    reject(new Error(line.substring(6)));
                } else {
                    reject(new Error('Invalid response: ' + line));
                }

            } catch (e) {
                reject(e);
            }
        });
    }

    // Helper methods
    async routeApp(appName, sinkName) {
        return await this.sendCommand(`ROUTE ${appName} ${sinkName}`);
    }

    async setVolume(sinkName, volume) {
        // Ensure volume is in valid range
        volume = Math.max(0, Math.min(1, volume));
        return await this.sendCommand(`SET_VOLUME ${sinkName} ${volume}`);
    }

    async setMute(sinkName, muted) {
        return await this.sendCommand(`MUTE ${sinkName} ${muted}`);
    }
}

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { IpcClient };
}