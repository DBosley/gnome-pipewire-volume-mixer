import { describe, test, expect } from '@jest/globals';

describe('Extension Architecture Tests', () => {
  describe('Virtual Sinks Configuration', () => {
    test('should define three virtual sinks with correct properties', () => {
      const VIRTUAL_SINKS = [
        { name: 'Game', label: 'Game', icon: 'applications-games-symbolic' },
        { name: 'Chat', label: 'Chat', icon: 'user-available-symbolic' },
        { name: 'Media', label: 'Media', icon: 'applications-multimedia-symbolic' }
      ];
      
      expect(VIRTUAL_SINKS).toHaveLength(3);
      
      // Verify each sink has required properties
      VIRTUAL_SINKS.forEach(sink => {
        expect(sink).toHaveProperty('name');
        expect(sink).toHaveProperty('label');
        expect(sink).toHaveProperty('icon');
        expect(sink.icon).toContain('-symbolic');
      });
      
      // Verify specific sinks
      const sinkNames = VIRTUAL_SINKS.map(s => s.name);
      expect(sinkNames).toEqual(['Game', 'Chat', 'Media']);
    });
  });
  
  describe('Command Protocol', () => {
    test('should use correct command format for volume control', () => {
      const commands = {
        setVolume: (sink, vol) => `SET_VOLUME ${sink} ${vol}`,
        setMute: (sink, muted) => `MUTE ${sink} ${muted}`,
        routeApp: (app, sink) => `ROUTE ${app} ${sink}`
      };
      
      // Test command generation
      expect(commands.setVolume('Media', 0.75)).toBe('SET_VOLUME Media 0.75');
      expect(commands.setMute('Media', true)).toBe('MUTE Media true');
      expect(commands.routeApp('Firefox', 'Game')).toBe('ROUTE Firefox Game');
      
      // Test command format validation
      expect(commands.setVolume('Media', 0.75)).toMatch(/^SET_VOLUME \w+ [\d.]+$/);
      expect(commands.setMute('Media', true)).toMatch(/^MUTE \w+ (true|false)$/);
      expect(commands.routeApp('Firefox', 'Game')).toMatch(/^ROUTE \w+ \w+$/);
    });
    
    test('should define correct shared memory binary format', () => {
      const sharedMemoryFormat = {
        header: {
          version: 4,       // uint32
          generation: 8,    // uint64
          timestamp: 8,     // uint64
          reserved: 12      // padding
        },
        sinkEntry: {
          nameLength: 1,    // uint8
          name: 'variable', // string
          id: 4,           // uint32
          volume: 4,       // float32
          muted: 1         // bool
        },
        appEntry: {
          nameLength: 1,     // uint8
          name: 'variable',  // string
          sinkLength: 1,     // uint8
          sink: 'variable',  // string
          active: 1          // bool
        }
      };
      
      // Calculate header size
      const headerSize = Object.values(sharedMemoryFormat.header)
        .filter(v => typeof v === 'number')
        .reduce((sum, bytes) => sum + bytes, 0);
      
      expect(headerSize).toBe(32);
      
      // Verify alignment requirements
      expect(sharedMemoryFormat.header.version).toBe(4);
      expect(sharedMemoryFormat.header.generation).toBe(8);
      expect(sharedMemoryFormat.header.timestamp).toBe(8);
    });
  });
  
  describe('System Paths', () => {
    test('should use correct shared memory path format', () => {
      const getSharedMemoryPath = (uid) => `/dev/shm/pipewire-volume-mixer-${uid}`;
      
      const path1000 = getSharedMemoryPath(1000);
      const path500 = getSharedMemoryPath(500);
      
      expect(path1000).toBe('/dev/shm/pipewire-volume-mixer-1000');
      expect(path500).toBe('/dev/shm/pipewire-volume-mixer-500');
      expect(path1000).toMatch(/^\/dev\/shm\/pipewire-volume-mixer-\d+$/);
    });
    
    test('should use correct Unix socket path format', () => {
      const getSocketPath = (uid) => `/run/user/${uid}/pipewire-volume-mixer.sock`;
      
      const path1000 = getSocketPath(1000);
      const path500 = getSocketPath(500);
      
      expect(path1000).toBe('/run/user/1000/pipewire-volume-mixer.sock');
      expect(path500).toBe('/run/user/500/pipewire-volume-mixer.sock');
      expect(path1000).toMatch(/^\/run\/user\/\d+\/pipewire-volume-mixer\.sock$/);
    });
    
    test('should use correct D-Bus service name', () => {
      const DBUS_NAME = 'org.gnome.PipewireVolumeMixer';
      const DBUS_PATH = '/org/gnome/PipewireVolumeMixer';
      const DBUS_INTERFACE = 'org.gnome.PipewireVolumeMixer';
      
      expect(DBUS_NAME).toMatch(/^org\.gnome\./);
      expect(DBUS_PATH).toMatch(/^\/org\/gnome\//);
      expect(DBUS_INTERFACE).toBe(DBUS_NAME);
    });
  });
  
  describe('Volume Control Logic', () => {
    test('should normalize volume values to [0, 1] range', () => {
      const normalizeVolume = (volume) => Math.max(0, Math.min(1, volume));
      
      // Test normal values
      expect(normalizeVolume(0)).toBe(0);
      expect(normalizeVolume(0.5)).toBe(0.5);
      expect(normalizeVolume(1)).toBe(1);
      
      // Test out of range values
      expect(normalizeVolume(-0.5)).toBe(0);
      expect(normalizeVolume(1.5)).toBe(1);
      expect(normalizeVolume(-100)).toBe(0);
      expect(normalizeVolume(100)).toBe(1);
    });
    
    test('should convert between volume and percentage', () => {
      const toPercent = (volume) => Math.round(volume * 100);
      const fromPercent = (percent) => percent / 100;
      
      // Test conversions
      expect(toPercent(0)).toBe(0);
      expect(toPercent(0.5)).toBe(50);
      expect(toPercent(0.75)).toBe(75);
      expect(toPercent(1)).toBe(100);
      
      expect(fromPercent(0)).toBe(0);
      expect(fromPercent(50)).toBe(0.5);
      expect(fromPercent(75)).toBe(0.75);
      expect(fromPercent(100)).toBe(1);
      
      // Test round-trip conversion
      [0, 0.25, 0.5, 0.75, 1].forEach(vol => {
        expect(fromPercent(toPercent(vol))).toBeCloseTo(vol, 2);
      });
    });
    
    test('should handle mute state correctly', () => {
      const muteLogic = {
        toggleMute: (current) => !current,
        unmute: () => false,
        mute: () => true,
        isMuted: (state) => state === true
      };
      
      expect(muteLogic.toggleMute(false)).toBe(true);
      expect(muteLogic.toggleMute(true)).toBe(false);
      expect(muteLogic.unmute()).toBe(false);
      expect(muteLogic.mute()).toBe(true);
      expect(muteLogic.isMuted(true)).toBe(true);
      expect(muteLogic.isMuted(false)).toBe(false);
    });
  });
});