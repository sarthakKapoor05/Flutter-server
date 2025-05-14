// server.js
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require('uuid'); // You'll need to install this: npm install uuid

// Create a WebSocket server at port 8080
const wss = new WebSocket.Server({ port: 8080 });

console.log("WebSocket server is running on ws://localhost:8080");

// Track all connected clients
const clients = new Set();

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

let clientIdCounter = 1;
function getClientList() {
  return Array.from(clients)
    .filter(ws => ws.deviceInfo)
    .map(ws => ({
      id: ws.deviceInfo.id,
      name: ws.deviceInfo.deviceName
    }));
}

wss.on("connection", function connection(ws) {
  console.log("A new client connected!");
  
  // Assign a unique ID to this client
  ws.id = uuidv4();
  ws.deviceName = "Unknown Device"; // Default name
  ws.deviceInfo = null; // Will be set on register_device
  
  // Add the client to our set
  clients.add(ws);

  // Notify all other clients about the new connection
  broadcastConnectedDevices();

  // Receive message from Flutter
  ws.on("message", function incoming(message) {
    try {
      // Check if the message is a string or binary data
      if (typeof message === "string" || message instanceof Buffer && message.toString().startsWith('{')) {
        // Try to parse as JSON to check if it's a file metadata message
        const data = JSON.parse(message.toString());
        
        // --- NEW: Handle sending file to another client ---
        if (data.type === "file_metadata" && data.targetId) {
          // Store pending transfer info
          pendingTransfers.set(ws, { targetId: data.targetId, metadata: data });
          ws.send(JSON.stringify({ type: "ready_for_file" }));
          return;
        }
        // --- NEW: Handle file received request ---
        if (data.type === "request_file" && data.targetId && data.filename) {
          // Find the target client
          const target = Array.from(clients).find(c => c.deviceInfo && c.deviceInfo.id === data.targetId);
          if (target) {
            // Ask the target client to send the file
            target.send(JSON.stringify({
              type: "request_file",
              filename: data.filename,
              fromId: ws.deviceInfo.id
            }));
          }
          return;
        } else if (data.type === "register_device") {
          // Register device name
          ws.deviceName = data.deviceName || `Device-${ws.id.substring(0, 6)}`;
          console.log(`Device registered: ${ws.deviceName}`);
          
          // Assign a unique id to each client
          ws.deviceInfo = {
            id: "client_" + (clientIdCounter++),
            deviceName: data.deviceName || "Unknown"
          };
          // Send the updated list to all clients
          const clientList = getClientList();
          clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: "connected_devices",
                devices: clientList
              }));
            }
          });
          return;
        } else if (data.type === "get_connected_devices") {
          // Send list of connected devices to the requesting client
          sendConnectedDevices(ws);
          return;
        } else if (data.type === "ping") {
          // Respond with pong to keep connection alive
          ws.send(JSON.stringify({ type: "pong" }));
          return;
        } else {
          // Regular text message
          console.log("Received:", data);
          
          // Echo back the message to the sender
          ws.send(JSON.stringify({ type: "message", text: `You said: ${JSON.stringify(data)}` }));
          
          // Broadcast to all other connected clients
          clients.forEach(client => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ type: "message", text: `Someone said: ${JSON.stringify(data)}` }));
            }
          });
        }
      } else {
        // --- NEW: Forward file binary data to target client if pending transfer ---
        if (pendingTransfers.has(ws)) {
          const { targetId, metadata } = pendingTransfers.get(ws);
          const target = Array.from(clients).find(c => c.deviceInfo && c.deviceInfo.id === targetId);
          if (target) {
            // Send metadata first
            target.send(JSON.stringify({
              type: "file_metadata",
              filename: metadata.filename,
              size: metadata.size,
              contentType: metadata.contentType,
              fromId: ws.deviceInfo.id
            }));
            // Then send the file data
            target.send(message);
          }
          pendingTransfers.delete(ws);
          return;
        }
        // Assume binary data is a file if we have metadata
        if (ws.fileMetadata) {
          const filePath = path.join(uploadsDir, ws.fileMetadata.filename);
          fs.writeFileSync(filePath, message);
          console.log(`Saved file: ${ws.fileMetadata.filename} (${message.length} bytes)`);
          
          // Acknowledge file receipt
          ws.send(JSON.stringify({ 
            type: "file_received", 
            filename: ws.fileMetadata.filename 
          }));
          
          // Notify other clients about new file
          clients.forEach(client => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ 
                type: "file_notification", 
                filename: ws.fileMetadata.filename,
                from: ws.deviceName || "another client" 
              }));
            }
          });
          
          // Clear the metadata
          ws.fileMetadata = null;
        } else {
          console.log("Received binary data but no file metadata");
          ws.send(JSON.stringify({ type: "error", message: "Received binary data without metadata" }));
        }
      }
    } catch (error) {
      console.error("Error processing message:", error);
      ws.send(JSON.stringify({ type: "error", message: "Failed to process message" }));
    }
  });

  ws.on("close", function close() {
    // Remove client from set when they disconnect
    clients.delete(ws);
    console.log(`Client disconnected: ${ws.deviceName || 'Unknown device'}`);
    
    // Broadcast updated list on disconnect
    const clientList = getClientList();
    clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: "connected_devices",
          devices: clientList
        }));
      }
    });
  });
});

// Map to store pending file transfers: { ws: { targetId, metadata } }
const pendingTransfers = new Map();

// Send connected devices to a specific client
function sendConnectedDevices(client) {
  if (client.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify({
      type: "connected_devices",
      devices: getClientList()  // Use getClientList instead
    }));
  }
}

// Broadcast connected devices to all clients
function broadcastConnectedDevices() {
  const devicesList = getClientList();  // Use getClientList instead
  console.log(devicesList);
  
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {  // Add safety check
      client.send(JSON.stringify({
        type: "connected_devices",
        devices: devicesList
      }));
    }
  });
}