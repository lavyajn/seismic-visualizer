// src/streaming/websocket.js
const WebSocket = require('ws');

class StreamManager {
    constructor(server, getCacheCallback) {
        this.wss = new WebSocket.Server({ server });
        this.clients = new Set();

        this.wss.on('connection', (ws) => {
            console.log(`[WebSocket] New client connected. Total clients: ${this.wss.clients.size}`);
            this.clients.add(ws);

            // instant syncs the current cache on new connection
            const currentData = getCacheCallback();
            if (currentData && currentData.length > 0) {
                const payload = JSON.stringify({
                    type: 'SEISMIC_UPDATE',
                    timestamp: Date.now(),
                    count: currentData.length,
                    events: currentData
                });
                ws.send(payload);
                console.log(`[WebSocket] Sent immediate cache sync (${currentData.length} events) to new client.`);
            }

            ws.on('close', () => {
                console.log(`[WebSocket] Client disconnected. Total clients: ${this.wss.clients.size}`);
                this.clients.delete(ws);
            });

            ws.on('error', (error) => {
                console.error(`[WebSocket Error]:`, error.message);
            });
        });
    }

    broadcast(data) {
        if (this.wss.clients.size === 0) return;

        const payload = JSON.stringify({
            type: 'SEISMIC_UPDATE',
            timestamp: Date.now(),
            count: data.length,
            events: data
        });

        this.wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(payload);
            }
        });
        
        console.log(`[WebSocket] Broadcasted ${data.length} events to ${this.wss.clients.size} clients.`);
    }
}

module.exports = StreamManager;