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

wss.on("connection", function connection(ws) {
  console.log("A new client connected!");
  
  // Assign a unique ID to this client
  ws.id = uuidv4();
  ws.deviceName = "Unknown Device"; // Default name
  
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
        
        if (data.type === "file_metadata") {
          // Store file metadata on the websocket connection for upcoming binary data
          ws.fileMetadata = {
            filename: data.filename,
            size: data.size,
            contentType: data.contentType
          };
          console.log(`Expecting file: ${data.filename} (${data.size} bytes)`);
          ws.send(JSON.stringify({ type: "ready_for_file" }));
          return;
        } else if (data.type === "request_file") {
          // Handle file request from client
          const filePath = path.join(uploadsDir, data.filename);
          if (fs.existsSync(filePath)) {
            // Send file metadata first
            const fileStats = fs.statSync(filePath);
            ws.send(JSON.stringify({
              type: "file_metadata",
              filename: data.filename,
              size: fileStats.size
            }));
            
            // Then send the file as binary data
            const fileData = fs.readFileSync(filePath);
            ws.send(fileData);
            console.log(`Sent file: ${data.filename}`);
          } else {
            ws.send(JSON.stringify({ type: "error", message: "File not found" }));
          }
          return;
        } else if (data.type === "register_device") {
          // Register device name
          ws.deviceName = data.deviceName || `Device-${ws.id.substring(0, 6)}`;
          console.log(`Device registered: ${ws.deviceName}`);
          // Notify all clients about updated device list
          broadcastConnectedDevices();
          return;
        } else if (data.type === "get_connected_devices") {
          // Send list of connected devices to the requesting client
          sendConnectedDevices(ws);
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
    
    // Notify remaining clients about the updated device list
    broadcastConnectedDevices();
  });
});

// Function to collect connected device information
function getConnectedDevices() {
  const devices = [];
  clients.forEach(client => {
    devices.push({
      id: client.id,
      deviceName: client.deviceName
    });
  });
  return devices;
}

// Send connected devices to a specific client
function sendConnectedDevices(client) {
  if (client.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify({
      type: "connected_devices",
      devices: getConnectedDevices()
    }));
  }
}

// Broadcast connected devices to all clients
function broadcastConnectedDevices() {
  const devicesList = getConnectedDevices();
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: "connected_devices",
        devices: devicesList
      }));
    }
  });
}