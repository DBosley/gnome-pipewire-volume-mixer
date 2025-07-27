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
        CENTER: 'center',
        FILL: 'fill',
        START: 'start',
        END: 'end'
      } 
    },
    St: {
      Icon: jest.fn().mockImplementation(function(config) {
        Object.assign(this, mockIcon, config);
      }),
      Label: jest.fn().mockImplementation(function(config) {
        Object.assign(this, mockLabel, config);
      }),
      BoxLayout: jest.fn().mockImplementation(function(config) {
        return {
          style_class: config?.style_class,
          x_expand: config?.x_expand,
          add_child: jest.fn(),
          add: jest.fn()
        };
      }),
      Button: jest.fn().mockImplementation(function(config) {
        return {
          child: config?.child || {},
          style_class: config?.style_class,
          can_focus: config?.can_focus,
          connect: jest.fn().mockReturnValue(1)
        };
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
      PopupSubMenuMenuItem: class MockPopupSubMenuMenuItem {
        constructor(text, wantIcon) {
          this._mockChildren = [];
          this._mockSignals = new Map();
          this.label = { text, hide: jest.fn(), destroy: jest.fn() };
          this._triangleBin = {};
          this._mockFirstChild = {
            insert_child_at_index: jest.fn()
          };
          this.menu = {
            removeAll: jest.fn(),
            addMenuItem: jest.fn(),
            _getMenuItems: jest.fn().mockReturnValue([]),
            connect: jest.fn()
          };
        }
        _init() {
          // Mock _init for compatibility
        }
        add_child(child) {
          this._mockChildren.push(child);
        }
        remove_child(child) {
          // Mock remove_child
        }
        insert_child_at_index(child, index) {
          this._mockChildren.splice(index, 0, child);
        }
        insert_child_below(child, sibling) {
          this._mockChildren.push(child);
        }
        get_first_child() {
          return this._mockFirstChild;
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
      PopupMenuItem: jest.fn().mockImplementation(function(text, params) {
        this.text = text;
        this.sensitive = true;
        this.connect = jest.fn();
      }),
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