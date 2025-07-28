#!/bin/bash
set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo "=== PipeWire Volume Mixer TTL Test ==="
echo ""

# Function to check if an app is in the cache
check_app_in_cache() {
    local app_name="$1"
    local shm_file="/dev/shm/pipewire-volume-mixer-$UID"
    
    if [ -f "$shm_file" ]; then
        # Extract JSON from shared memory (skip binary header)
        local json=$(xxd -p -s 32 "$shm_file" 2>/dev/null | xxd -r -p 2>/dev/null | strings | grep -o '{.*}' | head -1)
        if echo "$json" | jq -e ".apps | has(\"$app_name\")" >/dev/null 2>&1; then
            local active=$(echo "$json" | jq -r ".apps[\"$app_name\"].active")
            echo "true:$active"
        else
            echo "false:false"
        fi
    else
        echo "false:false"
    fi
}

# Function to monitor the daemon logs
monitor_logs() {
    echo -e "${YELLOW}Starting log monitor...${NC}"
    journalctl --user -u pipewire-volume-mixer-daemon.service -f --since "now" &
    LOG_PID=$!
}

# Function to play a test sound
play_sound() {
    echo -e "${GREEN}Playing a quick sound...${NC}"
    
    # Play a quick system bell sound
    paplay /usr/share/sounds/freedesktop/stereo/bell.oga 2>/dev/null || \
    paplay /usr/share/sounds/freedesktop/stereo/complete.oga 2>/dev/null || \
    paplay /usr/share/sounds/freedesktop/stereo/message.oga 2>/dev/null || \
    echo -e "${RED}No system sounds found${NC}"
}

# Kill log monitor on exit
cleanup() {
    if [ ! -z "$LOG_PID" ]; then
        kill $LOG_PID 2>/dev/null || true
    fi
}
trap cleanup EXIT

# Start monitoring logs
monitor_logs
sleep 1

echo ""
echo -e "${GREEN}Step 1: Playing a quick test sound...${NC}"
play_sound

# Give PipeWire time to register the stream
sleep 1

# Check if the app appears in cache
echo -e "${YELLOW}Checking cache for audio app...${NC}"
# paplay usually shows up as "Paplay" in the cache
result=$(check_app_in_cache "Paplay")
IFS=':' read -r exists active <<< "$result"

if [ "$exists" = "true" ]; then
    echo -e "${GREEN}✓ App found in cache (active=$active)${NC}"
else
    echo -e "${RED}✗ App not found in cache${NC}"
    echo "Checking for other apps..."
    
    # List all apps in cache
    shm_file="/dev/shm/pipewire-volume-mixer-$UID"
    if [ -f "$shm_file" ]; then
        json=$(xxd -p -s 32 "$shm_file" 2>/dev/null | xxd -r -p 2>/dev/null | strings | grep -o '{.*}' | head -1)
        echo "Apps in cache:"
        echo "$json" | jq -r '.apps | keys[]' 2>/dev/null || echo "Could not parse cache"
    fi
fi

echo ""
echo -e "${YELLOW}Waiting for sound to stop...${NC}"
sleep 3

echo ""
echo -e "${GREEN}Step 2: Sound stopped. App should be marked inactive.${NC}"
echo -e "${YELLOW}Waiting 5 seconds...${NC}"
sleep 5

# Check if app is still in cache but inactive
result=$(check_app_in_cache "Paplay")
IFS=':' read -r exists active <<< "$result"

if [ "$exists" = "true" ] && [ "$active" = "false" ]; then
    echo -e "${GREEN}✓ App still in cache but marked inactive${NC}"
elif [ "$exists" = "true" ] && [ "$active" = "true" ]; then
    echo -e "${RED}✗ App still marked as active (should be inactive)${NC}"
else
    echo -e "${RED}✗ App already removed from cache (too early)${NC}"
fi

echo ""
echo -e "${GREEN}Step 3: Waiting for TTL expiration (10 seconds total)...${NC}"
echo -e "${YELLOW}Waiting 7 more seconds...${NC}"
sleep 7

# Check if app has been removed
result=$(check_app_in_cache "Paplay")
IFS=':' read -r exists active <<< "$result"

if [ "$exists" = "false" ]; then
    echo -e "${GREEN}✓ App successfully removed from cache after TTL${NC}"
else
    echo -e "${RED}✗ App still in cache after TTL expired${NC}"
fi

echo ""
echo -e "${GREEN}Test complete!${NC}"
echo ""
echo "Check the logs above for:"
echo "1. 'App X is now inactive, will be removed in 10 seconds if not used'"
echo "2. 'Found X inactive apps'"
echo "3. 'Cleaned up X inactive apps after 10 second TTL'"

# Give time to see final log messages
sleep 2