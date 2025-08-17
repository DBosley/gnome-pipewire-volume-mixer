import { jest } from '@jest/globals';

// Mock for GNOME Shell imports
export const createGnomeMocks = () => {
  const mockGio = {
    DBusProxy: {
      new_for_bus_sync: jest.fn(),
    },
    BusType: {
      SESSION: 'session',
    },
    DBusProxyFlags: {
      NONE: 0,
    },
    DBusCallFlags: {
      NONE: 0,
    },
    SocketClient: jest.fn(() => ({
      connect: jest.fn(),
    })),
    UnixSocketAddress: jest.fn(),
    DataInputStream: {
      new: jest.fn(),
    },
    File: {
      new_for_path: jest.fn(() => ({
        query_exists: jest.fn(),
      })),
    },
  };

  const mockGLib = {
    Variant: jest.fn((signature, value) => ({
      deep_unpack: jest.fn(() => value),
      signature,
      value,
    })),
    Bytes: {
      new: jest.fn((data) => ({ data })),
    },
    FileTest: {
      EXISTS: 1,
    },
    file_test: jest.fn(() => false),
    build_filenamev: jest.fn((paths) => paths.join('/')),
    get_home_dir: jest.fn(() => '/home/test'),
    get_user_runtime_dir: jest.fn(() => '/run/user/1000'),
    timeout_add: jest.fn(),
    PRIORITY_DEFAULT: 0,
    SOURCE_REMOVE: false,
  };

  const mockExtensionUtils = {
    getCurrentExtension: jest.fn(() => ({
      imports: {
        dbusBackend: {
          DBusBackend: jest.fn(),
        },
      },
    })),
  };

  return {
    mockGio,
    mockGLib,
    mockExtensionUtils,
    imports: {
      gi: {
        Gio: mockGio,
        GLib: mockGLib,
      },
      misc: {
        extensionUtils: mockExtensionUtils,
      },
    },
  };
};

// Create a mock D-Bus proxy
export const createMockDBusProxy = (properties = {}, methods = {}) => {
  const signalCallbacks = {};
  const propertyChangeCallbacks = [];

  const proxy = {
    get_cached_property: jest.fn((name) => {
      if (properties[name] !== undefined) {
        return {
          deep_unpack: jest.fn(() => properties[name]),
        };
      }
      return null;
    }),
    
    call: jest.fn((method, params, flags, timeout, cancellable, callback) => {
      if (methods[method]) {
        setTimeout(() => {
          const result = methods[method](params);
          callback(proxy, {
            deep_unpack: () => [result],
          });
        }, 0);
      }
    }),
    
    call_finish: jest.fn((res) => res),
    
    connect: jest.fn((signal, callback) => {
      if (signal === 'g-properties-changed') {
        propertyChangeCallbacks.push(callback);
        return propertyChangeCallbacks.length - 1;
      }
      return Math.random();
    }),
    
    connectSignal: jest.fn((signal, callback) => {
      if (!signalCallbacks[signal]) {
        signalCallbacks[signal] = [];
      }
      signalCallbacks[signal].push(callback);
      return signalCallbacks[signal].length - 1;
    }),
    
    disconnect: jest.fn(),
    
    // Test helpers
    _emitSignal: (signal, ...args) => {
      if (signalCallbacks[signal]) {
        signalCallbacks[signal].forEach(cb => {
          cb(proxy, null, {
            deep_unpack: () => args,
          });
        });
      }
    },
    
    _emitPropertyChange: (changed) => {
      propertyChangeCallbacks.forEach(cb => {
        cb(proxy, {
          deep_unpack: () => changed,
        }, null);
      });
    },
  };

  return proxy;
};

// Create mock socket connection
export const createMockSocketConnection = (response = 'OK') => {
  return {
    get_output_stream: jest.fn(() => ({
      write_bytes: jest.fn(),
    })),
    get_input_stream: jest.fn(() => ({
      _mockInput: response,
    })),
    close: jest.fn(),
  };
};

// Test data factories
export const createTestSink = (name = 'Game', overrides = {}) => ({
  name,
  pipewireId: 100,
  volume: 0.75,
  muted: false,
  ...overrides,
});

export const createTestApp = (name = 'Firefox', overrides = {}) => ({
  name,
  displayName: name,
  currentSink: 'Game',
  pipewireId: 200,
  active: true,
  ...overrides,
});

// Wait for async operations
export const waitForAsync = () => new Promise(resolve => setTimeout(resolve, 0));

// Mock logger
export const createMockLogger = () => {
  const logs = [];
  const mockLog = jest.fn((message) => {
    logs.push(message);
  });
  
  // Replace global log function
  global.log = mockLog;
  
  return {
    mockLog,
    getLogs: () => logs,
    clearLogs: () => {
      logs.length = 0;
      mockLog.mockClear();
    },
  };
};