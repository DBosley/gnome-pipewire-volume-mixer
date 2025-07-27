// Comprehensive GNOME Shell API mocks

// Mock the global log function
global.log = jest.fn();

export const mockSlider = {
  value: 0,
  accessible_name: '',
  connect: jest.fn().mockReturnValue(1),
  disconnect: jest.fn(),
  block_signal_handler: jest.fn(),
  unblock_signal_handler: jest.fn()
};

export const mockIcon = {
  icon_name: '',
  style_class: ''
};

export const mockLabel = {
  text: '',
  y_expand: false,
  y_align: null
};

export const mockSubprocess = {
  communicate_utf8: jest.fn()
};

export const mockVolumeMenu = {
  addMenuItem: jest.fn()
};

export const createMockImports = () => ({
  gi: {
    Clutter: { 
      ActorAlign: { 
        CENTER: 'center' 
      } 
    },
    St: {
      Icon: jest.fn().mockImplementation(function(config) {
        Object.assign(this, mockIcon, config);
      }),
      Label: jest.fn().mockImplementation(function(config) {
        Object.assign(this, mockLabel, config);
      })
    },
    GObject: {
      registerClass: jest.fn((cls) => {
        // Return a constructor that calls _init
        return class extends cls {
          constructor(...args) {
            super();
            if (this._init) {
              this._init(...args);
            }
          }
        };
      })
    },
    Gio: {
      Subprocess: {
        new: jest.fn().mockReturnValue(mockSubprocess)
      },
      SubprocessFlags: {
        STDOUT_PIPE: 'stdout_pipe'
      }
    },
    GLib: {}
  },
  ui: {
    main: {
      panel: {
        statusArea: {
          aggregateMenu: {
            _volume: {
              _volumeMenu: mockVolumeMenu
            }
          }
        }
      }
    },
    popupMenu: {
      PopupBaseMenuItem: class MockPopupBaseMenuItem {
        constructor() {
          this._mockChildren = [];
          this._mockSignals = new Map();
        }
        _init() {
          // Mock _init for compatibility
        }
        add_child(child) {
          this._mockChildren.push(child);
        }
        connect(signal, callback) {
          const id = Math.random();
          this._mockSignals.set(id, { signal, callback });
          return id;
        }
        destroy() {
          this._destroyed = true;
        }
      },
      PopupSeparatorMenuItem: jest.fn().mockImplementation(function() {
        this.destroy = jest.fn();
      })
    },
    slider: {
      Slider: jest.fn().mockImplementation(function(value) {
        return Object.assign({}, mockSlider, { value });
      })
    }
  }
});