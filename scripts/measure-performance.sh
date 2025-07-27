#!/bin/bash
# Performance measurement script for current implementation

echo "PipeWire Volume Mixer - Performance Baseline Measurement"
echo "======================================================="
echo ""

# Function to measure command execution time
measure_time() {
    local cmd="$1"
    local iterations="${2:-10}"
    local total=0
    
    echo "Measuring: $cmd"
    echo -n "Progress: "
    
    for i in $(seq 1 $iterations); do
        echo -n "."
        local start=$(date +%s%N)
        eval "$cmd" > /dev/null 2>&1
        local end=$(date +%s%N)
        local duration=$((($end - $start) / 1000000)) # Convert to ms
        total=$(($total + $duration))
    done
    
    echo ""
    local avg=$(($total / $iterations))
    echo "Average time: ${avg}ms (over $iterations iterations)"
    echo ""
    
    return $avg
}

# Test 1: List sink inputs
echo "Test 1: Listing sink inputs"
measure_time "pactl list sink-inputs" 20

# Test 2: Get wpctl status
echo "Test 2: Getting wpctl status"
measure_time "wpctl status" 20

# Test 3: Move a sink input (simulate)
echo "Test 3: Simulating sink input move"
# First get a sink input ID if available
SINK_INPUT=$(pactl list sink-inputs short | head -1 | cut -f1)
if [ -n "$SINK_INPUT" ]; then
    measure_time "pactl move-sink-input $SINK_INPUT 0" 10
else
    echo "No sink inputs available for move test"
fi

# Test 4: Combined operation (what extension does)
echo "Test 4: Combined operation (extension simulation)"
measure_time "pactl list sink-inputs && wpctl status | grep -E 'Audio|Sink'" 10

# Test 5: pw-mon startup time
echo "Test 5: pw-mon startup and initial dump"
measure_time "timeout 0.5 pw-mon > /dev/null" 5

# Memory usage check
echo "Memory Usage Analysis"
echo "===================="

# Check current shell memory
echo "Baseline shell memory: $(ps -o rss= -p $$) KB"

# Run commands and check memory growth
for i in {1..10}; do
    pactl list sink-inputs > /dev/null 2>&1
    wpctl status > /dev/null 2>&1
done

echo "Shell memory after 10 iterations: $(ps -o rss= -p $$) KB"

# CPU usage during operations
echo ""
echo "CPU Usage Analysis"
echo "=================="
echo "Running 1-second CPU profile during operations..."

# Start monitoring in background
mpstat 1 1 > /tmp/cpu_before.txt 2>&1 &

# Run operations continuously for 1 second
timeout 1 bash -c 'while true; do pactl list sink-inputs > /dev/null 2>&1; done'

# Get CPU after
mpstat 1 1 > /tmp/cpu_during.txt 2>&1

echo "CPU usage before operations:"
tail -3 /tmp/cpu_before.txt | grep -v "^$"

echo ""
echo "CPU usage during operations:"
tail -3 /tmp/cpu_during.txt | grep -v "^$"

# Cleanup
rm -f /tmp/cpu_*.txt

echo ""
echo "Performance Baseline Complete"
echo "============================"
echo "These measurements represent the current subprocess-based implementation."
echo "The new daemon architecture should improve these by 10-100x."