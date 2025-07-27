import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { createMockImports, mockSubprocess } from './mocks/gnome-shell.js';

// Set up global mocks
let mockImports = createMockImports();
global.imports = mockImports;

// Import extension once
const extension = await import('../src/extension.js');

describe('Volume Control', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSubprocess.communicate_utf8.mockReset();
    global.imports.gi.Gio.Subprocess.new.mockClear();
  });

  describe('Volume reading', () => {
    test('should parse volume from pactl loopback', () => {
      mockSubprocess.communicate_utf8.mockReturnValueOnce([
        true,
        `Sink Input #42
        Driver: PipeWire
        node.name = "Game_to_Speaker"
        Volume: front-left: 45875 /  70% / -9.29 dB,   front-right: 45875 /  70% / -9.29 dB`,
        null
      ]);
      
      const sink = { name: 'Game', label: 'Game', icon: 'applications-games-symbolic' };
      const item = new extension.VirtualSinkItem(sink);
      
      expect(item._slider.value).toBe(0.7);
    });


    test('should handle error gracefully', () => {
      mockSubprocess.communicate_utf8.mockImplementation(() => {
        throw new Error('Command failed');
      });
      
      // Should not throw
      expect(() => {
        const sink = { name: 'Game', label: 'Game', icon: 'applications-games-symbolic' };
        new extension.VirtualSinkItem(sink);
      }).not.toThrow();
    });
  });

  describe('Volume setting', () => {


    test('should prevent feedback loops', () => {
      const sink = { name: 'Game', label: 'Game', icon: 'applications-games-symbolic' };
      const item = new extension.VirtualSinkItem(sink);
      
      const blockSpy = item._slider.block_signal_handler;
      const unblockSpy = item._slider.unblock_signal_handler;
      
      // Update volume should block/unblock handler
      mockSubprocess.communicate_utf8.mockReturnValueOnce([
        true,
        `Sink Input #1\nnode.name = "Game_to_Speaker"\nVolume: 60%`,
        null
      ]);
      
      item._updateVolume();
      
      expect(blockSpy).toHaveBeenCalledWith(item._sliderChangedId);
      expect(unblockSpy).toHaveBeenCalledWith(item._sliderChangedId);
    });
  });
});