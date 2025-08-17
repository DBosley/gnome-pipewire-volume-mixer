import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { 
  createGnomeMocks, 
  createMockDBusProxy,
  createTestApp,
  createMockLogger
} from './test-utils.js';

describe('DBusBackend', () => {
  let DBusBackend;
  let gnomeMocks;
  let mockProxy;
  let mockLogger;

  beforeEach(() => {
    
    // Set up mocks
    gnomeMocks = createGnomeMocks();
    mockLogger = createMockLogger();
    
    // Create mock proxy with test data
    const testProperties = {
      Sinks: {
        Game: {
          pipewire_id: { deep_unpack: () => 100 },
          volume: { deep_unpack: () => 0.75 },
          muted: { deep_unpack: () => false },
        },
        Chat: {
          pipewire_id: { deep_unpack: () => 101 },
          volume: { deep_unpack: () => 0.5 },
          muted: { deep_unpack: () => true },
        },
      },
      Applications: {
        Firefox: {
          display_name: { deep_unpack: () => 'Firefox' },
          current_sink: { deep_unpack: () => 'Game' },
          pipewire_id: { deep_unpack: () => 200 },
          active: { deep_unpack: () => true },
        },
        Discord: {
          display_name: { deep_unpack: () => 'Discord' },
          current_sink: { deep_unpack: () => 'Chat' },
          pipewire_id: { deep_unpack: () => 201 },
          active: { deep_unpack: () => true },
        },
      },
      Generation: 1,
      LastUpdate: 1234567890,
    };

    mockProxy = createMockDBusProxy(testProperties);
    
    // Mock Gio.DBusProxy constructor
    gnomeMocks.mockGio.DBusProxy.new_for_bus_sync.mockReturnValue(mockProxy);
    
    // Set up global imports
    global.imports = {
      gi: {
        Gio: gnomeMocks.mockGio,
        GLib: gnomeMocks.mockGLib,
      },
    };

    // Clear require cache for the module
    delete require.cache[require.resolve('../src/dbusBackend.js')];
    
    // Import the module fresh
    const dbusBackendModule = require('../src/dbusBackend.js');
    DBusBackend = dbusBackendModule.DBusBackend;
  });

  afterEach(() => {
    jest.clearAllMocks();
    if (mockLogger && mockLogger.clearLogs) {
      mockLogger.clearLogs();
    }
    delete global.imports;
    delete global.log;
  });

  describe('constructor', () => {
    test('should initialize and connect to D-Bus', () => {
      const backend = new DBusBackend();
      
      expect(backend._available).toBe(true);
      expect(gnomeMocks.mockGio.DBusProxy.new_for_bus_sync).toHaveBeenCalledWith(
        'session',
        0,
        null,
        'org.gnome.PipewireVolumeMixer',
        '/org/gnome/PipewireVolumeMixer',
        'org.gnome.PipewireVolumeMixer',
        null
      );
    });

    test('should handle connection failure gracefully', () => {
      gnomeMocks.mockGio.DBusProxy.new_for_bus_sync.mockImplementation(() => {
        throw new Error('Connection failed');
      });
      
      const backend = new DBusBackend();
      expect(backend._available).toBe(false);
      const logs = mockLogger.getLogs();
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0]).toContain('Failed to connect to D-Bus service');
    });

    test('should load initial state on successful connection', () => {
      const backend = new DBusBackend();
      
      expect(backend._cache.sinks).toHaveProperty('Game');
      expect(backend._cache.sinks).toHaveProperty('Chat');
      expect(backend._cache.apps).toHaveProperty('Firefox');
      expect(backend._cache.apps).toHaveProperty('Discord');
      expect(backend._cache.generation).toBe(1);
      expect(backend._cache.lastUpdate).toBe(1234567890);
    });
  });

  describe('isAvailable', () => {
    test('should return true when connected', () => {
      const backend = new DBusBackend();
      expect(backend.isAvailable()).toBe(true);
    });

    test('should return false when not connected', () => {
      gnomeMocks.mockGio.DBusProxy.new_for_bus_sync.mockImplementation(() => {
        throw new Error('Connection failed');
      });
      
      const backend = new DBusBackend();
      expect(backend.isAvailable()).toBe(false);
    });
  });

  describe('getSinks', () => {
    test('should return cached sinks', () => {
      const backend = new DBusBackend();
      const sinks = backend.getSinks();
      
      expect(sinks).toHaveProperty('Game');
      expect(sinks.Game).toEqual({
        name: 'Game',
        pipewireId: 100,
        volume: 0.75,
        muted: false,
      });
      
      expect(sinks).toHaveProperty('Chat');
      expect(sinks.Chat).toEqual({
        name: 'Chat',
        pipewireId: 101,
        volume: 0.5,
        muted: true,
      });
    });
  });

  describe('getApps', () => {
    test('should return cached applications', () => {
      const backend = new DBusBackend();
      const apps = backend.getApps();
      
      expect(apps).toHaveProperty('Firefox');
      expect(apps.Firefox).toEqual({
        name: 'Firefox',
        displayName: 'Firefox',
        currentSink: 'Game',
        pipewireId: 200,
        active: true,
      });
      
      expect(apps).toHaveProperty('Discord');
      expect(apps.Discord).toEqual({
        name: 'Discord',
        displayName: 'Discord',
        currentSink: 'Chat',
        pipewireId: 201,
        active: true,
      });
    });
  });

  describe('getAppsForSink', () => {
    test('should return apps connected to specific sink', () => {
      const backend = new DBusBackend();
      
      const gameApps = backend.getAppsForSink('Game');
      expect(gameApps).toHaveLength(1);
      expect(gameApps[0].name).toBe('Firefox');
      
      const chatApps = backend.getAppsForSink('Chat');
      expect(chatApps).toHaveLength(1);
      expect(chatApps[0].name).toBe('Discord');
    });

    test('should return empty array for non-existent sink', () => {
      const backend = new DBusBackend();
      const apps = backend.getAppsForSink('NonExistent');
      expect(apps).toEqual([]);
    });
  });

  describe('setSinkVolume', () => {
    test('should call D-Bus method and update cache optimistically', () => {
      const backend = new DBusBackend();
      
      const result = backend.setSinkVolume('Game', 0.9);
      expect(result).toBe(true);
      
      // Check optimistic update
      expect(backend._cache.sinks.Game.volume).toBe(0.9);
      
      // Check D-Bus call
      expect(mockProxy.call).toHaveBeenCalledWith(
        'SetSinkVolume',
        expect.objectContaining({
          signature: '(sd)',
          value: ['Game', 0.9],
        }),
        0,
        -1,
        null,
        expect.any(Function)
      );
    });

    test('should return false when no proxy available', () => {
      gnomeMocks.mockGio.DBusProxy.new_for_bus_sync.mockImplementation(() => {
        throw new Error('Connection failed');
      });
      
      const backend = new DBusBackend();
      const result = backend.setSinkVolume('Game', 0.9);
      expect(result).toBe(false);
    });
  });

  describe('setSinkMute', () => {
    test('should call D-Bus method and update cache optimistically', () => {
      const backend = new DBusBackend();
      
      const result = backend.setSinkMute('Game', true);
      expect(result).toBe(true);
      
      // Check optimistic update
      expect(backend._cache.sinks.Game.muted).toBe(true);
      
      // Check D-Bus call
      expect(mockProxy.call).toHaveBeenCalledWith(
        'SetSinkMute',
        expect.objectContaining({
          signature: '(sb)',
          value: ['Game', true],
        }),
        0,
        -1,
        null,
        expect.any(Function)
      );
    });
  });

  describe('routeApp', () => {
    test('should return promise that resolves on success', async () => {
      mockProxy.call.mockImplementation((_method, _params, _flags, _timeout, _cancellable, callback) => {
        setTimeout(() => {
          callback(mockProxy, {
            deep_unpack: () => [true],
          });
        }, 0);
      });
      
      const backend = new DBusBackend();
      const result = await backend.routeApp('Firefox', 'Chat');
      
      expect(result).toBe(true);
      expect(mockProxy.call).toHaveBeenCalledWith(
        'RouteApplication',
        expect.objectContaining({
          signature: '(ss)',
          value: ['Firefox', 'Chat'],
        }),
        0,
        -1,
        null,
        expect.any(Function)
      );
    });

    test('should reject promise on failure', async () => {
      mockProxy.call.mockImplementation((_method, _params, _flags, _timeout, _cancellable, callback) => {
        setTimeout(() => {
          callback(mockProxy, {
            deep_unpack: () => [false],
          });
        }, 0);
      });
      
      const backend = new DBusBackend();
      await expect(backend.routeApp('Firefox', 'NonExistent')).rejects.toThrow(
        'Failed to route Firefox to NonExistent'
      );
    });

    test('should reject when no proxy available', async () => {
      gnomeMocks.mockGio.DBusProxy.new_for_bus_sync.mockImplementation(() => {
        throw new Error('Connection failed');
      });
      
      const backend = new DBusBackend();
      await expect(backend.routeApp('Firefox', 'Chat')).rejects.toThrow(
        'No D-Bus proxy available'
      );
    });
  });

  describe('refreshState', () => {
    test('should call GetFullState and update cache', async () => {
      const freshState = {
        sinks: {
          Game: {
            pipewire_id: 100,
            volume: 0.85,
            muted: false,
          },
        },
        applications: {
          Chrome: {
            display_name: 'Chrome',
            current_sink: 'Game',
            pipewire_id: 202,
            active: true,
          },
        },
        generation: 2,
        last_update: 9999999999,
      };
      
      mockProxy.call.mockImplementation((method, _params, _flags, _timeout, _cancellable, callback) => {
        if (method === 'GetFullState') {
          setTimeout(() => {
            callback(mockProxy, {
              deep_unpack: () => [freshState],
            });
          }, 0);
        }
      });
      
      const backend = new DBusBackend();
      await backend.refreshState();
      
      expect(backend._cache.generation).toBe(2);
      expect(backend._cache.sinks.Game.volume).toBe(0.85);
      expect(backend._cache.apps).toHaveProperty('Chrome');
    });

    test('should resolve even on error', async () => {
      const backend = new DBusBackend();
      
      // Make the call method simulate an error in the callback
      backend._proxy.call = jest.fn((method, params, flags, timeout, cancellable, callback) => {
        // Simulate async error
        setTimeout(() => {
          try {
            callback(backend._proxy, {
              deep_unpack: () => {
                throw new Error('Unpack failed');
              }
            });
          } catch {
            // Error in callback
          }
        }, 0);
      });
      
      // Should still resolve (not throw)
      const result = await backend.refreshState();
      expect(result).toBeUndefined();
    });
  });

  describe('signal handling', () => {
    test('should handle StateChanged signal', () => {
      const backend = new DBusBackend();
      const callback = jest.fn();
      backend.connect('stateChanged', callback);
      
      // Emit signal
      mockProxy._emitSignal('StateChanged', 5);
      
      expect(backend._cache.generation).toBe(5);
      expect(callback).toHaveBeenCalledWith(5);
    });

    test('should handle SinkVolumeChanged signal', () => {
      const backend = new DBusBackend();
      const callback = jest.fn();
      backend.connect('sinkVolumeChanged', callback);
      
      // Emit signal
      mockProxy._emitSignal('SinkVolumeChanged', 'Game', 0.95);
      
      expect(backend._cache.sinks.Game.volume).toBe(0.95);
      expect(callback).toHaveBeenCalledWith('Game', 0.95);
    });

    test('should handle SinkMuteChanged signal', () => {
      const backend = new DBusBackend();
      const callback = jest.fn();
      backend.connect('sinkMuteChanged', callback);
      
      // Emit signal
      mockProxy._emitSignal('SinkMuteChanged', 'Chat', false);
      
      expect(backend._cache.sinks.Chat.muted).toBe(false);
      expect(callback).toHaveBeenCalledWith('Chat', false);
    });

    test('should handle ApplicationRouted signal', () => {
      const backend = new DBusBackend();
      const callback = jest.fn();
      backend.connect('applicationRouted', callback);
      
      // Emit signal
      mockProxy._emitSignal('ApplicationRouted', 'Firefox', 'Media');
      
      expect(backend._cache.apps.Firefox.currentSink).toBe('Media');
      expect(callback).toHaveBeenCalledWith('Firefox', 'Media');
    });

    test('should handle ApplicationsChanged signal', () => {
      const backend = new DBusBackend();
      const callback = jest.fn();
      backend.connect('applicationsChanged', callback);
      
      // Add Chrome to cache first
      backend._cache.apps.Chrome = createTestApp('Chrome');
      
      // Emit signal
      mockProxy._emitSignal('ApplicationsChanged', ['Spotify'], ['Chrome']);
      
      expect(backend._cache.apps).not.toHaveProperty('Chrome');
      expect(callback).toHaveBeenCalledWith(['Spotify'], ['Chrome']);
    });
  });

  describe('callback management', () => {
    test('should connect and disconnect callbacks', () => {
      const backend = new DBusBackend();
      const callback1 = jest.fn();
      const callback2 = jest.fn();
      
      backend.connect('stateChanged', callback1);
      backend.connect('stateChanged', callback2);
      
      // Emit signal - both should be called
      mockProxy._emitSignal('StateChanged', 10);
      expect(callback1).toHaveBeenCalledWith(10);
      expect(callback2).toHaveBeenCalledWith(10);
      
      // Disconnect callback1
      backend.disconnect('stateChanged', callback1);
      
      // Emit again - only callback2 should be called
      mockProxy._emitSignal('StateChanged', 11);
      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(2);
    });

    test('should handle callback errors gracefully', () => {
      const backend = new DBusBackend();
      const errorCallback = jest.fn(() => {
        throw new Error('Callback error');
      });
      const normalCallback = jest.fn();
      
      backend.connect('stateChanged', errorCallback);
      backend.connect('stateChanged', normalCallback);
      
      // Should not throw and other callbacks should still run
      expect(() => {
        mockProxy._emitSignal('StateChanged', 15);
      }).not.toThrow();
      
      expect(normalCallback).toHaveBeenCalledWith(15);
      const logs = mockLogger.getLogs();
      expect(logs.some(log => log.includes('Error in callback for stateChanged'))).toBe(true);
    });
  });

  describe('destroy', () => {
    test('should disconnect all signals and clear state', () => {
      const backend = new DBusBackend();
      const callback = jest.fn();
      backend.connect('stateChanged', callback);
      
      backend.destroy();
      
      expect(backend._proxy).toBeNull();
      expect(backend._available).toBe(false);
      expect(backend._callbacks.stateChanged).toEqual([]);
      expect(mockProxy.disconnect).toHaveBeenCalled();
    });
  });
});