#!/bin/bash

echo "Running GNOME PipeWire Volume Mixer Test Suite"
echo "=============================================="
echo ""

# Run the working test files
echo "Running integration tests..."
bun test __tests__/integration.test.js

echo ""
echo "Running system architecture tests..."
bun test __tests__/system.test.js

echo ""
echo "Running DBus backend tests..."
bun test __tests__/dbusBackend.simple.test.js

echo ""
echo "Running IPC client tests..."
bun test __tests__/ipcClient.simple.test.js

echo ""
echo "=============================================="
echo "Test Summary:"
bun test __tests__/integration.test.js __tests__/system.test.js __tests__/dbusBackend.simple.test.js __tests__/ipcClient.simple.test.js 2>&1 | tail -3