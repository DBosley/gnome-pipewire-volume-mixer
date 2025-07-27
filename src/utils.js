// Utility functions extracted for better testability

export function parseVolumeFromPactl(output, sinkName) {
    const blocks = output.split('Sink Input #');
    for (let block of blocks) {
        if (block.includes(`node.name = "${sinkName}_to_Speaker"`)) {
            const volMatch = block.match(/Volume:.*?(\d+)%/);
            if (volMatch) {
                return parseInt(volMatch[1]) / 100;
            }
        }
    }
    return null;
}

export function parseVolumeFromWpctl(output, sinkLabel) {
    const lines = output.split('\n');
    for (let line of lines) {
        if (line.includes(`${sinkLabel} Audio`)) {
            const volMatch = line.match(/\[vol:\s*([\d.]+)\]/);
            if (volMatch) {
                return parseFloat(volMatch[1]);
            }
        }
    }
    return null;
}

export function calculateVolumePercentage(sliderValue) {
    return Math.round(sliderValue * 100);
}