// server.js
const WebSocket = require("ws");

// Create a WebSocket server at port 8080
const wss = new WebSocket.Server({ port: 8080 });

console.log("WebSocket server is running on ws://localhost:8080");

wss.on("connection", function connection(ws) {
  console.log("A new client connected!");

  // Receive message from Flutter
  ws.on("message", function incoming(message) {
    console.log("Received:", message.toString());

    // Echo back the message to Flutter
    ws.send(`You said: ${message}`);
  });

  ws.on("close", function close() {
    console.log("Client disconnected");
  });
});
