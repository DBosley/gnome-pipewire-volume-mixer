import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { 
  createGnomeMocks,
  createMockDBusProxy,
  createTestApp,
  createMockLogger
} from './test-utils.js';

describe('Backend Integration Tests', () => {
  let DaemonBackend;
  let DBusBackend;
  let gnomeMocks;
  let mockLogger;
  let mockProxy;

  beforeEach(() => {
    
    gnomeMocks = createGnomeMocks();
    mockLogger = createMockLogger();
    
    // Create a comprehensive mock proxy
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
        Media: {
          pipewire_id: { deep_unpack: () => 102 },
          volume: { deep_unpack: () => 0.8 },
          muted: { deep_unpack: () => false },
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
        Spotify: {
          display_name: { deep_unpack: () => 'Spotify' },
          current_sink: { deep_unpack: () => 'Media' },
          pipewire_id: { deep_unpack: () => 202 },
          active: { deep_unpack: () => false },
        },
      },
      Generation: 1,
      LastUpdate: Date.now(),
    };

    mockProxy = createMockDBusProxy(testProperties);
    gnomeMocks.mockGio.DBusProxy.new_for_bus_sync.mockReturnValue(mockProxy);
    
    // Set up global imports
    global.imports = {
      gi: {
        Gio: gnomeMocks.mockGio,
        GLib: gnomeMocks.mockGLib,
      },
      misc: {
        extensionUtils: {
          getCurrentExtension: jest.fn(() => ({
            imports: {
              dbusBackend: {
                DBusBackend: require('../src/dbusBackend.js').DBusBackend,
              },
            },
          })),
        },
      },
    };

    // Clear require cache for modules
    delete require.cache[require.resolve('../src/dbusBackend.js')];
    delete require.cache[require.resolve('../src/daemonBackend.js')];
    
    // Import modules fresh
    const dbusBackendModule = require('../src/dbusBackend.js');
    DBusBackend = dbusBackendModule.DBusBackend;
    
    const daemonBackendModule = require('../src/daemonBackend.js');
    DaemonBackend = daemonBackendModule.DaemonBackend;
  });

  afterEach(() => {
    jest.clearAllMocks();
    if (mockLogger && mockLogger.clearLogs) {
      mockLogger.clearLogs();
    }
    delete global.imports;
    delete global.log;
  });

  describe('DaemonBackend with DBusBackend integration', () => {
    test('should delegate all operations to DBusBackend', () => {
      const backend = new DaemonBackend();
      
      // Test getSinks delegation
      const sinks = backend.getSinks();
      expect(sinks).toHaveProperty('Game');
      expect(sinks).toHaveProperty('Chat');
      expect(sinks).toHaveProperty('Media');
      
      // Test getApps delegation
      const apps = backend.getApps();
      expect(apps).toHaveProperty('Firefox');
      expect(apps).toHaveProperty('Discord');
      expect(apps).toHaveProperty('Spotify');
      
      // Test getAppsForSink delegation
      const gameApps = backend.getAppsForSink('Game');
      expect(gameApps).toHaveLength(1);
      expect(gameApps[0].name).toBe('Firefox');
    });

    test('should handle volume control through DBusBackend', () => {
      const backend = new DaemonBackend();
      
      backend.setVolume('Game', 0.9);
      
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

    test('should handle mute control through DBusBackend', () => {
      const backend = new DaemonBackend();
      
      backend.setMute('Chat', false);
      
      expect(mockProxy.call).toHaveBeenCalledWith(
        'SetSinkMute',
        expect.objectContaining({
          signature: '(sb)',
          value: ['Chat', false],
        }),
        0,
        -1,
        null,
        expect.any(Function)
      );
    });

    test('should handle app routing through DBusBackend', async () => {
      mockProxy.call.mockImplementation((method, params, flags, timeout, cancellable, callback) => {
        if (method === 'RouteApplication') {
          setTimeout(() => {
            callback(mockProxy, {
              deep_unpack: () => [true],
            });
          }, 0);
        }
      });
      
      const backend = new DaemonBackend();
      const result = await backend.routeApp('Firefox', 'Media');
      
      expect(result).toBe(true);
      expect(mockProxy.call).toHaveBeenCalledWith(
        'RouteApplication',
        expect.objectContaining({
          signature: '(ss)',
          value: ['Firefox', 'Media'],
        }),
        0,
        -1,
        null,
        expect.any(Function)
      );
    });
  });

  describe('Real-time updates via D-Bus signals', () => {
    test('should update cache when receiving volume change signal', () => {
      const dbusBackend = new DBusBackend();
      const daemonBackend = new DaemonBackend();
      
      // Initial state
      expect(daemonBackend.getSinks().Game.volume).toBe(0.75);
      
      // Emit volume change signal
      mockProxy._emitSignal('SinkVolumeChanged', 'Game', 0.95);
      
      // Check updated state
      expect(dbusBackend.getSinks().Game.volume).toBe(0.95);
      expect(daemonBackend.getSinks().Game.volume).toBe(0.95);
    });

    test('should update cache when receiving mute change signal', () => {
      const dbusBackend = new DBusBackend();
      const daemonBackend = new DaemonBackend();
      
      // Initial state
      expect(daemonBackend.getSinks().Chat.muted).toBe(true);
      
      // Emit mute change signal
      mockProxy._emitSignal('SinkMuteChanged', 'Chat', false);
      
      // Check updated state
      expect(dbusBackend.getSinks().Chat.muted).toBe(false);
      expect(daemonBackend.getSinks().Chat.muted).toBe(false);
    });

    test('should update cache when app is routed', () => {
      const dbusBackend = new DBusBackend();
      const daemonBackend = new DaemonBackend();
      
      // Initial state
      expect(daemonBackend.getApps().Firefox.currentSink).toBe('Game');
      
      // Emit routing signal
      mockProxy._emitSignal('ApplicationRouted', 'Firefox', 'Media');
      
      // Check updated state
      expect(dbusBackend.getApps().Firefox.currentSink).toBe('Media');
      expect(daemonBackend.getApps().Firefox.currentSink).toBe('Media');
      
      // Verify app lists are updated
      const mediaApps = daemonBackend.getAppsForSink('Media');
      expect(mediaApps.some(app => app.name === 'Firefox')).toBe(true);
    });

    test('should handle application lifecycle changes', () => {
      const dbusBackend = new DBusBackend();
      
      // Add a new app to cache
      dbusBackend._cache.apps.Chrome = createTestApp('Chrome', { currentSink: 'Game' });
      
      // Initial state
      expect(dbusBackend.getApps()).toHaveProperty('Chrome');
      
      // Emit applications changed signal
      mockProxy._emitSignal('ApplicationsChanged', ['Teams'], ['Chrome']);
      
      // Check Chrome was removed
      expect(dbusBackend.getApps()).not.toHaveProperty('Chrome');
    });
  });

  describe('Error handling and recovery', () => {
    test('should handle D-Bus connection failure gracefully', () => {
      gnomeMocks.mockGio.DBusProxy.new_for_bus_sync.mockImplementation(() => {
        throw new Error('D-Bus connection failed');
      });
      
      const backend = new DaemonBackend();
      
      // Should return empty/default values
      expect(backend.getSinks()).toEqual({});
      expect(backend.getApps()).toEqual({});
      expect(backend.getAppsForSink('Game')).toEqual([]);
      expect(backend.getCache()).toBeNull();
    });

    test('should handle routing failure and log error', async () => {
      mockProxy.call.mockImplementation((method, params, flags, timeout, cancellable, callback) => {
        if (method === 'RouteApplication') {
          setTimeout(() => {
            callback(mockProxy, {
              deep_unpack: () => [false],
            });
          }, 0);
        }
      });
      
      const backend = new DaemonBackend();
      
      await expect(backend.routeApp('Firefox', 'NonExistent')).rejects.toThrow(
        'Failed to route Firefox to NonExistent'
      );
      
      const logs = mockLogger.getLogs();
      expect(logs.some(log => log.includes('Failed to route Firefox to NonExistent'))).toBe(true);
    });

    test('should recover from temporary D-Bus unavailability', () => {
      const daemonBackend = new DaemonBackend();
      
      // Initially available
      expect(daemonBackend.isDaemonAvailable()).toBe(true);
      
      // Simulate D-Bus becoming unavailable
      daemonBackend._dbusBackend._available = false;
      daemonBackend._lastAvailabilityCheck = 0; // Force re-check
      
      expect(daemonBackend.isDaemonAvailable()).toBe(false);
      
      // Simulate D-Bus becoming available again
      daemonBackend._dbusBackend._available = true;
      daemonBackend._lastAvailabilityCheck = 0; // Force re-check
      
      expect(daemonBackend.isDaemonAvailable()).toBe(true);
    });
  });

  describe('Performance and caching', () => {
    test('should cache daemon availability for 5 seconds', () => {
      const backend = new DaemonBackend();
      
      // Mock the isAvailable method
      let isAvailableCallCount = 0;
      backend._dbusBackend.isAvailable = jest.fn(() => {
        isAvailableCallCount++;
        return true;
      });
      
      // First check
      backend.isDaemonAvailable();
      expect(isAvailableCallCount).toBe(1);
      
      // Multiple checks within 5 seconds should use cache
      backend.isDaemonAvailable();
      backend.isDaemonAvailable();
      backend.isDaemonAvailable();
      expect(isAvailableCallCount).toBe(1);
      
      // Simulate 6 seconds passing
      backend._lastAvailabilityCheck = Date.now() - 6000;
      
      // Should check again
      backend.isDaemonAvailable();
      expect(isAvailableCallCount).toBe(2);
    });

    test('should provide consistent cache data structure', () => {
      const backend = new DaemonBackend();
      const cache = backend.getCache();
      
      expect(cache).toHaveProperty('sinks');
      expect(cache).toHaveProperty('apps');
      
      // Verify structure matches expected format
      expect(Object.keys(cache.sinks)).toEqual(['Game', 'Chat', 'Media']);
      expect(Object.keys(cache.apps)).toEqual(['Firefox', 'Discord', 'Spotify']);
      
      // Verify sink structure
      Object.values(cache.sinks).forEach(sink => {
        expect(sink).toHaveProperty('name');
        expect(sink).toHaveProperty('pipewireId');
        expect(sink).toHaveProperty('volume');
        expect(sink).toHaveProperty('muted');
      });
      
      // Verify app structure
      Object.values(cache.apps).forEach(app => {
        expect(app).toHaveProperty('name');
        expect(app).toHaveProperty('displayName');
        expect(app).toHaveProperty('currentSink');
        expect(app).toHaveProperty('pipewireId');
        expect(app).toHaveProperty('active');
      });
    });
  });

  describe('Cleanup and resource management', () => {
    test('should properly clean up resources on destroy', () => {
      const backend = new DaemonBackend();
      
      // Mock the destroy method
      const destroyCalled = { called: false };
      backend._dbusBackend.destroy = jest.fn(() => {
        destroyCalled.called = true;
      });
      
      backend.destroy();
      
      expect(destroyCalled.called).toBe(true);
      expect(backend._dbusBackend).toBeNull();
      
      // Should handle multiple destroy calls
      expect(() => backend.destroy()).not.toThrow();
    });

    test('should disconnect all D-Bus signals on destroy', () => {
      const dbusBackend = new DBusBackend();
      const signalIds = [1, 2, 3, 4, 5];
      dbusBackend._signalIds = [...signalIds];
      
      dbusBackend.destroy();
      
      expect(mockProxy.disconnect).toHaveBeenCalledTimes(signalIds.length);
      expect(dbusBackend._signalIds).toEqual([]);
    });
  });
});