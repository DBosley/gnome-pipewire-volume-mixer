#!/usr/bin/env python3
import os
import struct
import sys
from datetime import datetime

def read_string(data, offset):
    """Read a length-prefixed string from binary data"""
    if offset >= len(data):
        return None, offset
    
    length = data[offset]
    offset += 1
    
    if offset + length > len(data):
        return None, offset
    
    string = data[offset:offset + length].decode('utf-8', errors='ignore')
    offset += length
    
    return string, offset

def parse_shared_memory(filename):
    """Parse the shared memory binary format"""
    try:
        with open(filename, 'rb') as f:
            data = f.read()
        
        if len(data) < 32:
            print("File too small to contain valid data")
            return
        
        # Parse header (32 bytes)
        version = struct.unpack('<I', data[0:4])[0]
        generation = struct.unpack('<Q', data[4:12])[0]
        timestamp = struct.unpack('<Q', data[12:20])[0]
        
        print(f"Shared Memory Cache Debug")
        print(f"========================")
        print(f"Version: {version}")
        print(f"Generation: {generation}")
        print(f"Timestamp: {datetime.fromtimestamp(timestamp/1000)}")
        print()
        
        offset = 32
        
        # Read sinks
        if offset + 4 > len(data):
            print("No sink data found")
            return
            
        sink_count = struct.unpack('<I', data[offset:offset+4])[0]
        offset += 4
        
        print(f"Sinks ({sink_count}):")
        for i in range(sink_count):
            name, offset = read_string(data, offset)
            if name is None:
                break
                
            if offset + 9 > len(data):
                break
                
            sink_id = struct.unpack('<I', data[offset:offset+4])[0]
            offset += 4
            
            volume = struct.unpack('<f', data[offset:offset+4])[0]
            offset += 4
            
            muted = data[offset] == 1
            offset += 1
            
            print(f"  - {name}: id={sink_id}, volume={volume:.2f}, muted={muted}")
        
        print()
        
        # Read apps
        if offset + 4 > len(data):
            print("No app data found")
            return
            
        app_count = struct.unpack('<I', data[offset:offset+4])[0]
        offset += 4
        
        print(f"Apps ({app_count}):")
        for i in range(app_count):
            # App name
            name, offset = read_string(data, offset)
            if name is None:
                break
            
            # Current sink
            current_sink, offset = read_string(data, offset)
            if current_sink is None:
                break
            
            if offset >= len(data):
                break
                
            # Active flag
            active = data[offset] == 1
            offset += 1
            
            status = "active" if active else "inactive"
            print(f"  - {name}: sink='{current_sink}', {status}")
        
        print()
        print(f"Total size: {len(data)} bytes")
        
    except FileNotFoundError:
        print(f"Shared memory file not found: {filename}")
    except Exception as e:
        print(f"Error parsing shared memory: {e}")

if __name__ == "__main__":
    uid = os.getenv('UID', '1000')
    shm_file = f"/dev/shm/pipewire-volume-mixer-{uid}"
    parse_shared_memory(shm_file)