import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { createMockImports, mockSubprocess, mockVolumeMenu } from './mocks/gnome-shell.js';

// Set up global mocks before importing
let mockImports = createMockImports();
global.imports = mockImports;

// Import extension once with mocks set up
const extension = await import('../src/extension.js');

describe('GNOME PipeWire Volume Mixer Extension', () => {
  beforeEach(() => {
    // Clear all mocks
    jest.clearAllMocks();
    
    // Reset mock state
    mockSubprocess.communicate_utf8.mockReset();
    mockVolumeMenu.addMenuItem.mockReset();
  });

  describe('Constants', () => {
    test('VIRTUAL_SINKS should be properly defined', () => {
      expect(extension.VIRTUAL_SINKS).toBeDefined();
      expect(extension.VIRTUAL_SINKS).toHaveLength(3);
      expect(extension.VIRTUAL_SINKS).toEqual([
        { name: 'Game', label: 'Game', icon: 'applications-games-symbolic' },
        { name: 'Chat', label: 'Chat', icon: 'user-available-symbolic' },
        { name: 'Media', label: 'Media', icon: 'applications-multimedia-symbolic' }
      ]);
    });
  });

  describe('VirtualSinkItem', () => {
    test('should create with correct components', () => {
      const sink = { name: 'Game', label: 'Game', icon: 'applications-games-symbolic' };
      const item = new extension.VirtualSinkItem(sink);
      
      // Check icon creation
      expect(mockImports.gi.St.Icon).toHaveBeenCalledWith({
        icon_name: 'applications-games-symbolic',
        style_class: 'popup-menu-icon'
      });
      
      // Check slider creation
      expect(mockImports.ui.slider.Slider).toHaveBeenCalledWith(0);
      
      // Check that components were added as children
      expect(item._mockChildren).toHaveLength(2);
    });

    test('should connect slider change handler', () => {
      const sink = { name: 'Game', label: 'Game', icon: 'applications-games-symbolic' };
      const item = new extension.VirtualSinkItem(sink);
      
      expect(item._slider.connect).toHaveBeenCalledWith(
        'notify::value',
        expect.any(Function)
      );
      expect(item._sliderChangedId).toBeDefined();
    });

    test('should update volume on initialization', () => {
      mockSubprocess.communicate_utf8.mockReturnValueOnce([
        true,
        `Sink Input #123
        node.name = "Game_to_Speaker"
        Volume: front-left: 32768 /  50% / -18.06 dB`,
        null
      ]);
      
      const sink = { name: 'Game', label: 'Game', icon: 'applications-games-symbolic' };
      const item = new extension.VirtualSinkItem(sink);
      
      expect(mockImports.gi.Gio.Subprocess.new).toHaveBeenCalledWith(
        ['pactl', 'list', 'sink-inputs'],
        'stdout_pipe'
      );
      
      expect(item._slider.value).toBe(0.5);
    });

    test('should handle volume changes', () => {
      mockSubprocess.communicate_utf8.mockReturnValue([true, '', null]);
      
      const sink = { name: 'Game', label: 'Game', icon: 'applications-games-symbolic' };
      const item = new extension.VirtualSinkItem(sink);
      
      // Reset mocks after initialization
      jest.clearAllMocks();
      
      // Simulate slider change
      item._slider.value = 0.75;
      item._sliderChanged();
      
      // Check that subprocess was called
      expect(mockImports.gi.Gio.Subprocess.new).toHaveBeenCalled();
    });

    test('should disconnect handlers on destroy', () => {
      const sink = { name: 'Game', label: 'Game', icon: 'applications-games-symbolic' };
      const item = new extension.VirtualSinkItem(sink);
      
      const sliderDisconnect = item._slider.disconnect;
      const sliderId = item._sliderChangedId;
      
      item._onDestroy();
      
      expect(sliderDisconnect).toHaveBeenCalledWith(sliderId);
      expect(item._sliderChangedId).toBe(0);
    });
  });

  describe('Extension lifecycle', () => {
    test('enable should create menu items', () => {
      // Clear any previous state
      extension.virtualSinkItems.length = 0;
      mockVolumeMenu.addMenuItem.mockClear();
      
      extension.enable();
      
      // Should create separator
      expect(mockImports.ui.popupMenu.PopupSeparatorMenuItem).toHaveBeenCalled();
      
      // Should add items to menu
      expect(mockVolumeMenu.addMenuItem).toHaveBeenCalledTimes(4); // 1 separator + 3 sinks
      
      // Should create VirtualSinkItem for each sink
      expect(extension.virtualSinkItems).toHaveLength(4); // 1 separator + 3 sinks
    });


    test('disable should handle empty items gracefully', () => {
      // Reset virtualSinkItems to empty
      extension.virtualSinkItems.length = 0;
      
      // Disable without enabling first
      expect(() => extension.disable()).not.toThrow();
      expect(extension.virtualSinkItems).toHaveLength(0);
    });
  });
});