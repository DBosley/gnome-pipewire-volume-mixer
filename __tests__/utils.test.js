import { describe, test, expect } from '@jest/globals';
import { parseVolumeFromPactl, parseVolumeFromWpctl, calculateVolumePercentage } from '../src/utils.js';

describe('Utils - Volume Parsing', () => {
  test('parseVolumeFromPactl should extract volume correctly', () => {
    const pactlOutput = `Sink Input #42
    Driver: PipeWire
    Properties:
        node.name = "Game_to_Speaker"
    Volume: front-left: 45875 /  70% / -9.29 dB`;
    
    const volume = parseVolumeFromPactl(pactlOutput, 'Game');
    expect(volume).toBe(0.7);
  });

  test('parseVolumeFromPactl should return null if sink not found', () => {
    const pactlOutput = `Sink Input #42
    Properties:
        node.name = "Other_to_Speaker"
    Volume: front-left: 45875 /  70% / -9.29 dB`;
    
    const volume = parseVolumeFromPactl(pactlOutput, 'Game');
    expect(volume).toBeNull();
  });

  test('parseVolumeFromPactl should return null if volume format is invalid', () => {
    const pactlOutput = `Sink Input #42
    Properties:
        node.name = "Game_to_Speaker"
    Volume: invalid format`;
    
    const volume = parseVolumeFromPactl(pactlOutput, 'Game');
    expect(volume).toBeNull();
  });

  test('parseVolumeFromWpctl should extract volume correctly', () => {
    const wpctlOutput = ` └─ Sinks:
        45. Built-in Audio Analog Stereo        [vol: 0.74]
     *  64. Game Audio                          [vol: 0.85]
        65. Chat Audio                          [vol: 0.60]`;
    
    const volume = parseVolumeFromWpctl(wpctlOutput, 'Game');
    expect(volume).toBe(0.85);
  });

  test('parseVolumeFromWpctl should return null if sink not found', () => {
    const wpctlOutput = ` └─ Sinks:
        45. Built-in Audio Analog Stereo        [vol: 0.74]
        65. Chat Audio                          [vol: 0.60]`;
    
    const volume = parseVolumeFromWpctl(wpctlOutput, 'Game');
    expect(volume).toBeNull();
  });

  test('parseVolumeFromWpctl should return null if volume format is invalid', () => {
    const wpctlOutput = ` └─ Sinks:
        64. Game Audio                          [vol: invalid]`;
    
    const volume = parseVolumeFromWpctl(wpctlOutput, 'Game');
    expect(volume).toBeNull();
  });

  test('calculateVolumePercentage should convert slider value to percentage', () => {
    expect(calculateVolumePercentage(0)).toBe(0);
    expect(calculateVolumePercentage(0.5)).toBe(50);
    expect(calculateVolumePercentage(0.75)).toBe(75);
    expect(calculateVolumePercentage(1)).toBe(100);
    expect(calculateVolumePercentage(0.333)).toBe(33);
  });
});