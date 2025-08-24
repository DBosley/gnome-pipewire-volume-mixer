import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { 
  createGnomeMocks, 
  createTestSink,
  createTestApp,
  createMockLogger
} from './test-utils.js';

describe('DaemonBackend', () => {
  let DaemonBackend;
  let mockDBusBackend;
  let mockGnomeMocks;
  let mockLogger;

  beforeEach(() => {
    
    // Set up mocks
    mockGnomeMocks = createGnomeMocks();
    mockLogger = createMockLogger();
    
    // Mock DBusBackend
    mockDBusBackend = {
      isAvailable: jest.fn(() => true),
      getSinks: jest.fn(() => ({
        Game: createTestSink('Game'),
        Chat: createTestSink('Chat', { volume: 0.5 }),
      })),
      getApps: jest.fn(() => ({
        Firefox: createTestApp('Firefox'),
        Discord: createTestApp('Discord', { currentSink: 'Chat' }),
      })),
      getAppsForSink: jest.fn((sinkName) => {
        const apps = {
          Game: [createTestApp('Firefox')],
          Chat: [createTestApp('Discord', { currentSink: 'Chat' })],
        };
        return apps[sinkName] || [];
      }),
      setSinkVolume: jest.fn(),
      setSinkMute: jest.fn(),
      routeApp: jest.fn(() => Promise.resolve(true)),
      destroy: jest.fn(),
    };

    // Mock the DBusBackend constructor
    const DBusBackendMock = jest.fn(() => mockDBusBackend);
    
    // Set up global imports mock
    global.imports = {
      misc: {
        extensionUtils: {
          getCurrentExtension: jest.fn(() => ({
            imports: {
              dbusBackend: {
                DBusBackend: DBusBackendMock,
              },
            },
          })),
        },
      },
    };

    // Clear require cache for the module
    delete require.cache[require.resolve('../src/daemonBackend.js')];
    
    // Import the module fresh
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

  describe('constructor', () => {
    test('should initialize with DBusBackend', () => {
      const backend = new DaemonBackend();
      expect(backend._dbusBackend).toBeDefined();
      expect(backend._available).toBe(false);
      expect(backend._lastAvailabilityCheck).toBe(0);
    });
  });

  describe('isDaemonAvailable', () => {
    test('should check availability and cache result', () => {
      const backend = new DaemonBackend();
      
      // First call - should check backend
      const result1 = backend.isDaemonAvailable();
      expect(mockDBusBackend.isAvailable).toHaveBeenCalledTimes(1);
      expect(result1).toBe(true);
      expect(backend._available).toBe(true);
      
      // Second call within 5 seconds - should use cache
      const result2 = backend.isDaemonAvailable();
      expect(mockDBusBackend.isAvailable).toHaveBeenCalledTimes(1);
      expect(result2).toBe(true);
    });

    test('should refresh availability after 5 seconds', () => {
      const backend = new DaemonBackend();
      
      // First check
      backend.isDaemonAvailable();
      expect(mockDBusBackend.isAvailable).toHaveBeenCalledTimes(1);
      
      // Simulate time passing
      backend._lastAvailabilityCheck = Date.now() - 6000;
      
      // Should check again
      backend.isDaemonAvailable();
      expect(mockDBusBackend.isAvailable).toHaveBeenCalledTimes(2);
    });

    test('should log when daemon is not available', () => {
      mockDBusBackend.isAvailable.mockReturnValue(false);
      const backend = new DaemonBackend();
      
      const result = backend.isDaemonAvailable();
      expect(result).toBe(false);
      expect(mockLogger.getLogs()).toContain('Virtual Audio Sinks: Daemon not available');
    });
  });

  describe('getCache', () => {
    test('should return sinks and apps when daemon is available', () => {
      const backend = new DaemonBackend();
      const cache = backend.getCache();
      
      expect(cache).toEqual({
        sinks: {
          Game: createTestSink('Game'),
          Chat: createTestSink('Chat', { volume: 0.5 }),
        },
        apps: {
          Firefox: createTestApp('Firefox'),
          Discord: createTestApp('Discord', { currentSink: 'Chat' }),
        },
      });
    });

    test('should return null when daemon is not available', () => {
      mockDBusBackend.isAvailable.mockReturnValue(false);
      const backend = new DaemonBackend();
      
      const cache = backend.getCache();
      expect(cache).toBeNull();
    });
  });

  describe('getSinks', () => {
    test('should return sinks from DBusBackend', () => {
      const backend = new DaemonBackend();
      const sinks = backend.getSinks();
      
      expect(sinks).toHaveProperty('Game');
      expect(sinks).toHaveProperty('Chat');
      expect(mockDBusBackend.getSinks).toHaveBeenCalled();
    });

    test('should return empty object when daemon is not available', () => {
      mockDBusBackend.isAvailable.mockReturnValue(false);
      const backend = new DaemonBackend();
      
      const sinks = backend.getSinks();
      expect(sinks).toEqual({});
    });
  });

  describe('getApps', () => {
    test('should return apps from DBusBackend', () => {
      const backend = new DaemonBackend();
      const apps = backend.getApps();
      
      expect(apps).toHaveProperty('Firefox');
      expect(apps).toHaveProperty('Discord');
      expect(mockDBusBackend.getApps).toHaveBeenCalled();
    });

    test('should return empty object when daemon is not available', () => {
      mockDBusBackend.isAvailable.mockReturnValue(false);
      const backend = new DaemonBackend();
      
      const apps = backend.getApps();
      expect(apps).toEqual({});
    });
  });

  describe('getAppsForSink', () => {
    test('should return apps for specific sink', () => {
      const backend = new DaemonBackend();
      
      const gameApps = backend.getAppsForSink('Game');
      expect(gameApps).toHaveLength(1);
      expect(gameApps[0].name).toBe('Firefox');
      
      const chatApps = backend.getAppsForSink('Chat');
      expect(chatApps).toHaveLength(1);
      expect(chatApps[0].name).toBe('Discord');
    });

    test('should return empty array when daemon is not available', () => {
      mockDBusBackend.isAvailable.mockReturnValue(false);
      const backend = new DaemonBackend();
      
      const apps = backend.getAppsForSink('Game');
      expect(apps).toEqual([]);
    });
  });

  describe('routeApp', () => {
    test('should route app through DBusBackend', async () => {
      const backend = new DaemonBackend();
      
      await expect(backend.routeApp('Firefox', 'Chat')).resolves.toBe(true);
      expect(mockDBusBackend.routeApp).toHaveBeenCalledWith('Firefox', 'Chat');
    });

    test('should reject when daemon is not available', async () => {
      mockDBusBackend.isAvailable.mockReturnValue(false);
      const backend = new DaemonBackend();
      
      await expect(backend.routeApp('Firefox', 'Chat')).rejects.toThrow('Daemon not available');
      expect(mockLogger.getLogs()).toContain('Virtual Audio Sinks: Daemon not available for routing');
    });

    test('should propagate errors from DBusBackend', async () => {
      mockDBusBackend.routeApp.mockRejectedValue(new Error('Routing failed'));
      const backend = new DaemonBackend();
      
      await expect(backend.routeApp('Firefox', 'Chat')).rejects.toThrow('Routing failed');
    });
  });

  describe('setVolume', () => {
    test('should set volume through DBusBackend', () => {
      const backend = new DaemonBackend();
      
      backend.setVolume('Game', 0.8);
      expect(mockDBusBackend.setSinkVolume).toHaveBeenCalledWith('Game', 0.8);
    });

    test('should log error when daemon is not available', async () => {
      mockDBusBackend.isAvailable.mockReturnValue(false);
      const backend = new DaemonBackend();
      
      await expect(backend.setVolume('Game', 0.8)).rejects.toThrow('Daemon not available');
      expect(mockDBusBackend.setSinkVolume).not.toHaveBeenCalled();
      expect(mockLogger.getLogs()).toContain('Virtual Audio Sinks: Daemon not available for volume change');
    });
  });

  describe('setMute', () => {
    test('should set mute state through DBusBackend', () => {
      const backend = new DaemonBackend();
      
      backend.setMute('Game', true);
      expect(mockDBusBackend.setSinkMute).toHaveBeenCalledWith('Game', true);
    });

    test('should log error when daemon is not available', async () => {
      mockDBusBackend.isAvailable.mockReturnValue(false);
      const backend = new DaemonBackend();
      
      await expect(backend.setMute('Game', true)).rejects.toThrow('Daemon not available');
      expect(mockDBusBackend.setSinkMute).not.toHaveBeenCalled();
      expect(mockLogger.getLogs()).toContain('Virtual Audio Sinks: Daemon not available for mute change');
    });
  });

  describe('destroy', () => {
    test('should destroy DBusBackend and clean up', () => {
      const backend = new DaemonBackend();
      
      backend.destroy();
      expect(mockDBusBackend.destroy).toHaveBeenCalled();
      expect(backend._dbusBackend).toBeNull();
    });

    test('should handle destroy when already destroyed', () => {
      const backend = new DaemonBackend();
      
      backend.destroy();
      backend.destroy(); // Second call
      
      expect(mockDBusBackend.destroy).toHaveBeenCalledTimes(1);
    });
  });
});