// Global test setup for GNOME Shell modules
import { jest } from '@jest/globals';

// Set up module cache
const moduleCache = {};

// Mock require for CommonJS compatibility
global.require = jest.fn((modulePath) => {
  // Remove leading '../' if present
  const cleanPath = modulePath.replace(/^\.\.\//, '');
  
  if (moduleCache[cleanPath]) {
    return moduleCache[cleanPath];
  }
  
  // Create mock module
  const mockModule = {};
  moduleCache[cleanPath] = mockModule;
  return mockModule;
});

// Register module exports
global.module = {
  exports: {}
};

// Mock console.log as global log function
global.log = jest.fn();

// Export registration function for modules
export const registerModule = (path, exports) => {
  moduleCache[path] = exports;
};