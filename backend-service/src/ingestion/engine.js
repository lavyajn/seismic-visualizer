const axios = require('axios');
const { pruneSeismicData } = require('../processing/dataProcessor');

const USGS_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/1.0_hour.geojson';

class IngestionEngine {
    constructor(broadcastCallback, intervalMs = 180000) { // Default 3 mins
        this.cache = [];
        this.broadcast = broadcastCallback;
        this.intervalMs = intervalMs;
        this.timer = null;
    }

    async fetchAndProcess() {
        try {
            console.log(`[Ingestion] Pinging USGS API...`);
            const response = await axios.get(USGS_URL);
            
            // Process and strip the junk
            const freshData = pruneSeismicData(response.data);
            
            this.cache = freshData;
            console.log(`[Ingestion] Successfully updated cache with ${this.cache.length} active events.`);
            
            // Broadcast the fresh cache to all live WebSocket connections
            this.broadcast(this.cache);
        } catch (error) {
            console.error(`[Ingestion Error] Failed to sync with USGS:`, error.message);
        }
    }

    start() {
        // Run immediately on boot
        this.fetchAndProcess();
        
        // Setup the periodic cycle
        this.timer = setInterval(() => this.fetchAndProcess(), this.intervalMs);
        console.log(`[Ingestion Loop] Started. Polling every ${this.intervalMs / 1000} seconds.`);
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
    }

    getCache() {
        return this.cache;
    }
}

module.exports = IngestionEngine;