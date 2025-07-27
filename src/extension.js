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
        
        this._icon = new St.Icon({
            icon_name: sink.icon,
            style_class: 'popup-menu-icon'
        });
        this.add_child(this._icon);
        
        this._slider = new Slider.Slider(0);
        this._sliderChangedId = this._slider.connect('notify::value', this._sliderChanged.bind(this));
        this._slider.accessible_name = sink.label;
        this.add_child(this._slider);
        
        this.connect('destroy', this._onDestroy.bind(this));
        
        this._updateVolume();
    }
    
    _onDestroy() {
        if (this._sliderChangedId) {
            this._slider.disconnect(this._sliderChangedId);
            this._sliderChangedId = 0;
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
        let item = new VirtualSinkItem(sink);
        volumeMenu.addMenuItem(item, 3 + index);
        virtualSinkItems.push(item);
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