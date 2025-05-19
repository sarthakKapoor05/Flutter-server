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
            console.log(`File request from ${ws.deviceName}: ${data.filename}`);
            
            // Ask the target client to send the file
            target.send(JSON.stringify({
              type: "request_file",
              filename: data.filename,
              fromId: ws.deviceInfo.id,
              requesterId: ws.deviceInfo.id
            }));
            
            // Log the request
            console.log(`Forwarding file request for "${data.filename}" from ${ws.deviceName} to ${target.deviceName}`);
          } else {
            ws.send(JSON.stringify({
              type: "error",
              message: "Target device not found or offline"
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
          
          // Request file listing from the newly connected client
          ws.send(JSON.stringify({
            type: "request_initial_file_list"
          }));
          
          return;
        } else if (data.type === "initial_file_list_response") {
          // Display the client's storage structure in a more visual way
          displayClientStorageStructure(ws.deviceName, data.files || []);
          
          // Log client files to console in a nice format
          console.log(`\n====== Files from ${ws.deviceName} ======`);
          
          const folders = (data.files || []).filter(file => file.isDirectory);
          const regularFiles = (data.files || []).filter(file => !file.isDirectory);
          
          // Display folders
          if (folders.length > 0) {
            console.log("\n📁 FOLDERS:");
            folders.forEach(folder => {
              console.log(`  - ${folder.name}`);
            });
          } else {
            console.log("\n📁 FOLDERS: None");
          }
          
          // Display files with size and modification date
          if (regularFiles.length > 0) {
            console.log("\n📄 FILES:");
            regularFiles.forEach(file => {
              // Format size nicely
              let sizeStr = "Unknown size";
              if (file.size !== undefined) {
                if (file.size < 1024) sizeStr = `${file.size} B`;
                else if (file.size < 1024 * 1024) sizeStr = `${(file.size / 1024).toFixed(1)} KB`;
                else if (file.size < 1024 * 1024 * 1024) sizeStr = `${(file.size / (1024 * 1024)).toFixed(1)} MB`;
                else sizeStr = `${(file.size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
              }
              
              // Format date if available
              let dateStr = "";
              if (file.modified) {
                try {
                  const date = new Date(file.modified);
                  dateStr = date.toLocaleString();
                } catch (e) {
                  dateStr = "Unknown date";
                }
              }
              
              console.log(`  - ${file.name} (${sizeStr})${dateStr ? ' - ' + dateStr : ''}`);
            });
          } else {
            console.log("\n📄 FILES: None");
          }
          
          // Print total counts
          console.log(`\n📊 SUMMARY: ${folders.length} folders, ${regularFiles.length} files`);
          console.log("==============================\n");
          
          // Broadcast the file listing to all other clients (keep sending all files)
          clients.forEach(client => {
            if (client !== ws && client.readyState === WebSocket.OPEN && client.deviceInfo) {
              client.send(JSON.stringify({
                type: "device_files_update",
                deviceId: ws.deviceInfo.id,
                deviceName: ws.deviceName || "Unknown Device",
                files: data.files || []
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
        } else if (data.type === "list_files" && data.targetId) {
          // Handle file list request
          // Find the target client
          const target = Array.from(clients).find(c => c.deviceInfo && c.deviceInfo.id === data.targetId);
          if (target) {
            console.log(`Forwarding file list request from ${ws.deviceInfo.id} to ${data.targetId}`);
            
            // Forward the request to the target client
            target.send(JSON.stringify({
              type: "request_file_list",
              requesterId: ws.deviceInfo.id,
              path: data.path || ''
            }));
          } else {
            console.log(`Target client ${data.targetId} not found for file list request`);
            ws.send(JSON.stringify({
              type: "error",
              message: "Target device not found or offline"
            }));
          }
          return;
        } else if (data.type === "file_list_response" && data.requesterId) {
          // Use the helper function to forward directory listing responses
          handleDirectoryListingResponse(ws, data);
          return;
        } else if (data.type === "request_file_access" && data.targetId) {
          // Find the target client
          const target = Array.from(clients).find(c => c.deviceInfo && c.deviceInfo.id === data.targetId);
          if (target) {
            console.log(`${ws.deviceInfo.id} is requesting file access from ${data.targetId}`);
            
            // Forward the access request to target
            target.send(JSON.stringify({
              type: "file_access_request",
              requesterId: ws.deviceInfo.id,
              requesterName: ws.deviceName || "Unknown Device"
            }));
          } else {
            ws.send(JSON.stringify({
              type: "error",
              message: "Target device not found or offline"
            }));
          }
          return;
        } else if (data.type === "file_access_response") {
          // Handle permission response
          const requester = Array.from(clients).find(c => c.deviceInfo && c.deviceInfo.id === data.requesterId);
          if (requester) {
            // Forward the response to the requesting client
            requester.send(JSON.stringify({
              type: "file_access_response",
              granted: data.granted,
              targetId: ws.deviceInfo.id,
              targetName: ws.deviceName
            }));
            
            console.log(`File access ${data.granted ? 'granted' : 'denied'} by ${ws.deviceInfo.id} to ${data.requesterId}`);
          }
          return;
        } else if (data.type === "request_directory_listing" && data.targetId && data.path !== undefined) {
          // Forward the request to target device
          const targetClient = clients.find(client => 
            client.deviceInfo && client.deviceInfo.id === data.targetId
          );
          
          if (targetClient && targetClient.readyState === WebSocket.OPEN) {
            console.log(`Forwarding directory listing request: ${data.path} from ${ws.deviceName} to ${targetClient.deviceName}`);
            
            targetClient.send(JSON.stringify({
              type: "directory_listing_request",
              path: data.path,
              requesterId: data.requesterId,
            }));
          } else {
            ws.send(JSON.stringify({
              type: "error",
              message: "Target device not connected or unavailable"
            }));
          }
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
          
          // First save the file to server
          const filePath = path.join(uploadsDir, metadata.filename);
          fs.writeFileSync(filePath, message);
          console.log(`Saved file to server: ${metadata.filename} (${message.length} bytes)`);
          
          // Then forward to target client
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
            
            // Acknowledge successful transfer to sender
            ws.send(JSON.stringify({
              type: "file_transferred",
              filename: metadata.filename,
              stored: true,
              forwarded: true
            }));
          } else {
            // Target client not found, but file still saved on server
            ws.send(JSON.stringify({
              type: "file_transferred",
              filename: metadata.filename,
              stored: true,
              forwarded: false,
              error: "Target client not found or disconnected"
            }));
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

// Add this function at the bottom of your server.js file
function displayClientStorageStructure(deviceName, files) {
  // Create an ASCII tree representation of the files
  let tree = `\n📱 ${deviceName}'s Storage:\n`;
  
  // First add folders
  const folders = files.filter(f => f.isDirectory).sort((a, b) => a.name.localeCompare(b.name));
  
  folders.forEach(folder => {
    tree += `├── 📁 ${folder.name}\n`;
  });
  
  // Then add files (limit to 15 to avoid cluttering the console)
  const fileList = files.filter(f => !f.isDirectory).sort((a, b) => a.name.localeCompare(b.name));
  const displayFiles = fileList.slice(0, 15);
  
  displayFiles.forEach((file, i) => {
    const isLast = i === displayFiles.length - 1 && i === fileList.length - 1;
    const prefix = isLast ? '└── ' : '├── ';
    tree += `${prefix}📄 ${file.name}\n`;
  });
  
  if (fileList.length > 15) {
    tree += `└── ... ${fileList.length - 15} more files\n`;
  }
  
  console.log(tree);
}

// Add this after the displayClientStorageStructure function

function handleDirectoryListingResponse(ws, data) {
  // Find the requesting client
  const requester = Array.from(clients).find(c => 
    c.deviceInfo && c.deviceInfo.id === data.requesterId
  );
  
  if (requester && requester.readyState === WebSocket.OPEN) {
    // Forward the directory content with source information
    requester.send(JSON.stringify({
      type: "file_list_response",
      sourceId: ws.deviceInfo.id,
      sourceName: ws.deviceName || 'Unknown Device',
      path: data.path || '',
      files: data.files || [],
      error: data.error,
      requesterId: data.requesterId
    }));
    
    // Log the response
    console.log(`Directory listing response from ${ws.deviceName} for path "${data.path || 'root'}"`);
    if (data.files && data.files.length > 0) {
      console.log(`  - ${data.files.filter(f => f.isDirectory).length} folders, ${data.files.filter(f => !f.isDirectory).length} files`);
    } else if (data.error) {
      console.log(`  - Error: ${data.error}`);
    } else {
      console.log('  - No files');
    }
  } else {
    console.log(`Requester ${data.requesterId} not found or disconnected`);
  }
}

// Add this in the "file_metadata" handling section:

if (data.type === "file_metadata") {
  console.log(`📎 File metadata received: ${data.filename}`);
  console.log(`   - Size: ${formatFileSize(data.size)}`);
  console.log(`   - From: ${ws.deviceName}`);
  console.log(`   - To: ${data.targetId ? "Client " + data.targetId : "All clients"}`);
  
  // ... rest of your existing file_metadata handling
}

// Add this helper function at the bottom of your file
function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}