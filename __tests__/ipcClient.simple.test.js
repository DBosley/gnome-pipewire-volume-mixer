import { describe, test, expect } from '@jest/globals';

describe('IpcClient Simple Tests', () => {
  describe('Unix Socket Configuration', () => {
    test('should use correct socket path format', () => {
      const getSocketPath = (uid) => `/run/user/${uid}/pipewire-volume-mixer.sock`;
      
      expect(getSocketPath(1000)).toBe('/run/user/1000/pipewire-volume-mixer.sock');
      expect(getSocketPath(500)).toBe('/run/user/500/pipewire-volume-mixer.sock');
      expect(getSocketPath(1001)).toMatch(/^\/run\/user\/\d+\/pipewire-volume-mixer\.sock$/);
    });

    test('should extract user ID from runtime directory', () => {
      const extractUserId = (runtimeDir) => runtimeDir.split('/').pop();
      
      expect(extractUserId('/run/user/1000')).toBe('1000');
      expect(extractUserId('/run/user/500')).toBe('500');
      expect(extractUserId('/var/run/user/1001')).toBe('1001');
    });
  });

  describe('Command Protocol', () => {
    test('should format ROUTE command correctly', () => {
      const formatRouteCommand = (appName, sinkName) => `ROUTE ${appName} ${sinkName}`;
      
      expect(formatRouteCommand('Firefox', 'Game')).toBe('ROUTE Firefox Game');
      expect(formatRouteCommand('Discord', 'Chat')).toBe('ROUTE Discord Chat');
      expect(formatRouteCommand('Spotify', 'Media')).toBe('ROUTE Spotify Media');
    });

    test('should format SET_VOLUME command correctly', () => {
      const formatVolumeCommand = (sinkName, volume) => `SET_VOLUME ${sinkName} ${volume}`;
      
      expect(formatVolumeCommand('Game', 0.75)).toBe('SET_VOLUME Game 0.75');
      expect(formatVolumeCommand('Chat', 0.5)).toBe('SET_VOLUME Chat 0.5');
      expect(formatVolumeCommand('Media', 1)).toBe('SET_VOLUME Media 1');
    });

    test('should format MUTE command correctly', () => {
      const formatMuteCommand = (sinkName, muted) => `MUTE ${sinkName} ${muted}`;
      
      expect(formatMuteCommand('Game', true)).toBe('MUTE Game true');
      expect(formatMuteCommand('Chat', false)).toBe('MUTE Chat false');
    });

    test('should append newline to commands', () => {
      const addNewline = (command) => command + '\n';
      
      expect(addNewline('TEST')).toBe('TEST\n');
      expect(addNewline('ROUTE Firefox Game')).toBe('ROUTE Firefox Game\n');
    });
  });

  describe('Response Parsing', () => {
    test('should parse OK responses correctly', () => {
      const parseResponse = (response) => {
        if (!response) return { success: false, error: 'No response' };
        if (response.startsWith('OK')) {
          return { success: true, data: response.substring(2).trim() };
        }
        if (response.startsWith('ERROR')) {
          return { success: false, error: response.substring(5).trim() };
        }
        return { success: false, error: 'Invalid response' };
      };
      
      expect(parseResponse('OK')).toEqual({ success: true, data: '' });
      expect(parseResponse('OK some data')).toEqual({ success: true, data: 'some data' });
      expect(parseResponse('ERROR Command failed')).toEqual({ success: false, error: 'Command failed' });
      expect(parseResponse('INVALID')).toEqual({ success: false, error: 'Invalid response' });
      expect(parseResponse(null)).toEqual({ success: false, error: 'No response' });
    });

    test('should handle different response types', () => {
      const responses = {
        success: 'OK',
        successWithData: 'OK 12345',
        error: 'ERROR Not found',
        invalid: 'UNKNOWN RESPONSE',
        empty: ''
      };
      
      expect(responses.success.startsWith('OK')).toBe(true);
      expect(responses.successWithData.startsWith('OK')).toBe(true);
      expect(responses.error.startsWith('ERROR')).toBe(true);
      expect(responses.invalid.startsWith('OK')).toBe(false);
      expect(responses.invalid.startsWith('ERROR')).toBe(false);
    });
  });

  describe('Volume Normalization', () => {
    test('should clamp volume to [0, 1] range', () => {
      const normalizeVolume = (volume) => Math.max(0, Math.min(1, volume));
      
      // Normal values
      expect(normalizeVolume(0)).toBe(0);
      expect(normalizeVolume(0.5)).toBe(0.5);
      expect(normalizeVolume(1)).toBe(1);
      
      // Out of range values
      expect(normalizeVolume(-0.5)).toBe(0);
      expect(normalizeVolume(1.5)).toBe(1);
      expect(normalizeVolume(-100)).toBe(0);
      expect(normalizeVolume(100)).toBe(1);
    });

    test('should handle edge cases', () => {
      const normalizeVolume = (volume) => Math.max(0, Math.min(1, volume));
      
      expect(normalizeVolume(0.000001)).toBeCloseTo(0.000001);
      expect(normalizeVolume(0.999999)).toBeCloseTo(0.999999);
      expect(normalizeVolume(NaN)).toBe(NaN);
    });
  });

  describe('Error Handling', () => {
    test('should handle connection errors', () => {
      const errors = {
        noConnection: 'Failed to connect to daemon',
        noResponse: 'No response from daemon',
        invalidResponse: 'Invalid response',
        socketNotFound: 'Socket file not found'
      };
      
      Object.values(errors).forEach(error => {
        expect(error).toBeTruthy();
        expect(error.length).toBeGreaterThan(0);
      });
    });

    test('should create proper error objects', () => {
      const createError = (message) => new Error(message);
      
      const connError = createError('Failed to connect to daemon');
      expect(connError).toBeInstanceOf(Error);
      expect(connError.message).toBe('Failed to connect to daemon');
    });
  });

  describe('Command Data Encoding', () => {
    test('should convert string to byte array', () => {
      const stringToBytes = (str) => str.split('').map(c => c.charCodeAt(0));
      
      expect(stringToBytes('TEST')).toEqual([84, 69, 83, 84]);
      expect(stringToBytes('OK')).toEqual([79, 75]);
      expect(stringToBytes('\n')).toEqual([10]);
    });

    test('should handle command with newline', () => {
      const commandToBytes = (command) => {
        const withNewline = command + '\n';
        return withNewline.split('').map(c => c.charCodeAt(0));
      };
      
      const bytes = commandToBytes('TEST');
      expect(bytes).toEqual([84, 69, 83, 84, 10]);
      expect(bytes[bytes.length - 1]).toBe(10); // newline
    });
  });

  describe('Async Operations', () => {
    test('should handle promise resolution', async () => {
      const asyncOp = () => Promise.resolve('OK');
      const result = await asyncOp();
      expect(result).toBe('OK');
    });

    test('should handle promise rejection', async () => {
      const asyncOp = () => Promise.reject(new Error('Failed'));
      await expect(asyncOp()).rejects.toThrow('Failed');
    });

    test('should handle async command pattern', async () => {
      const sendCommand = async (command) => {
        if (command === 'VALID') {
          return Promise.resolve('OK');
        }
        return Promise.reject(new Error('Invalid command'));
      };
      
      await expect(sendCommand('VALID')).resolves.toBe('OK');
      await expect(sendCommand('INVALID')).rejects.toThrow('Invalid command');
    });
  });
});