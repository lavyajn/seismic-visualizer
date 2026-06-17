const WebSocket = require('ws');
const axios = require('axios');
// IMPORT FIXED: Using your actual function name
const { pruneSeismicData } = require('./src/processing/dataProcessor'); 

const wss = new WebSocket.Server({ port: 8080 });

// The USGS Time Machine Endpoints
const FEEDS = {
    'hour': 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/1.0_hour.geojson',
    'day': 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/1.0_day.geojson',
    'week': 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/1.0_week.geojson'
};

// Default state
let currentFeed = 'hour'; 

async function fetchAndBroadcast() {
    try {
        console.log(`[SYNC] Fetching ${currentFeed} data...`);
        const response = await axios.get(FEEDS[currentFeed]);
        
        // Use the correct function name. This returns a raw array.
        const eventsArray = pruneSeismicData(response.data);
        
        // Wrap it so the frontend doesn't throw a tantrum
        const payload = JSON.stringify({
            events: eventsArray,
            count: eventsArray.length,
            timestamp: Date.now(), // Giving the UI clock something to read
            timeframe: currentFeed
        });

        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(payload);
            }
        });
        console.log(`[BROADCAST] Sent ${eventsArray.length} anomalies to clients.`);
    } catch (error) {
        console.error('[ERROR] USGS API Fetch Failed:', error.message);
    }
}

wss.on('connection', (ws) => {
    console.log('[CLIENT CONNECTED] Spawning new tactical feed...');
    
    // Immediately send the current data so they don't stare at a blank screen
    fetchAndBroadcast();

    // The two-way radio logic
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.command === 'change_timeframe' && FEEDS[data.value]) {
                console.log(`[COMMAND RX] Client requested timeframe shift to: ${data.value}`);
                currentFeed = data.value;
                // Immediately trigger a fetch so the UI updates instantly
                fetchAndBroadcast();
            }
        } catch (e) {
            console.error('[ERROR] Failed to parse client message:', e);
        }
    });

    ws.on('close', () => console.log('[CLIENT DISCONNECTED]'));
});

// Still poll every 3 minutes to keep the active feed fresh
setInterval(fetchAndBroadcast, 3 * 60 * 1000);

console.log(`=========================================`);
console.log(`Seismic Broker Microservice Online`);
console.log(`📡 WebSocket Port: 8080`);
console.log(`=========================================`);