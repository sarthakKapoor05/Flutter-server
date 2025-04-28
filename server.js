// server.js
const WebSocket = require("ws");

// Create a WebSocket server at port 8080
const wss = new WebSocket.Server({ port: 8080 });

console.log("WebSocket server is running on ws://localhost:8080");

// Track all connected clients
const clients = new Set();

wss.on("connection", function connection(ws) {
  console.log("A new client connected!");
  
  // Add the client to our set
  clients.add(ws);

  // Receive message from Flutter
  ws.on("message", function incoming(message) {
    console.log("Received:", message.toString());

    // Echo back the message to the sender
    ws.send(`You said: ${message}`);
    
    // Broadcast to all other connected clients
    clients.forEach(client => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(`Someone said: ${message}`);
      }
    });
  });

  ws.on("close", function close() {
    // Remove client from set when they disconnect
    clients.delete(ws);
    console.log("Client disconnected");
  });
});