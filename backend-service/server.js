// server.js
const express = require('express');
const http = require('http');
const StreamManager = require('./src/streaming/websocket');
const IngestionEngine = require('./src/ingestion/engine');

// Setup basic Express server (useful for a simple health check)
const app = express();
const server = http.createServer(app);

// Initialize systems
const PORT = process.env.PORT || 8080;
const POLLING_INTERVAL = 3 * 60 * 1000; // 3 minutes

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'Online', service: 'Seismic Broker' });
});
let engine; 

// 1. Start the WebSocket manager, give it a way to ask for current data
const streamManager = new StreamManager(server, () => engine ? engine.getCache() : []);

// 2. Start the Ingestion Engine, passing it the broadcast function
engine = new IngestionEngine((data) => {
    streamManager.broadcast(data);
}, POLLING_INTERVAL);

// 3. Boot the server
server.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`🚀 Seismic Broker Microservice Online`);
    console.log(`📡 WebSocket Port: ${PORT}`);
    console.log(`=========================================`);
    
    // Start pulling data
    engine.start();
});