/**
 * CrossDrop Signaling Server
 * Ultra-lightweight WebRTC signaling & device pairing relay.
 */

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Store connected clients: Map<deviceId, { ws, deviceId, deviceName, deviceType, pairKey, ip, lastSeen }>
const clients = new Map();
// Map<pairKey, Set<deviceId>>
const rooms = new Map();
// Temporary 6-digit pairing codes: Map<code, { pairKey, createdAt }>
const pinCodes = new Map();

// Clean expired 6-digit PINs (valid for 10 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of pinCodes.entries()) {
    if (now - entry.createdAt > 10 * 60 * 1000) {
      pinCodes.delete(code);
    }
  }
}, 60 * 1000);

const path = require('path');
const fs = require('fs');

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'CrossDrop Signaling Server',
      version: '1.0.0',
      connectedClients: clients.size,
      activeRooms: rooms.size,
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // Direct file save endpoint for Mac (stream file directly to Documents/CrossDrop_Received)
  if (req.method === 'POST' && req.url === '/api/save-file') {
    const rawName = decodeURIComponent(req.headers['x-filename'] || 'received_file');
    const safeName = path.basename(rawName).replace(/[/\\?%*:|"<>]/g, '_') || 'received_file';
    const homeDir = process.env.HOME || '/Users/' + (process.env.USER || 'patric132');
    const targetDir = path.join(homeDir, 'Documents', 'CrossDrop_Received');
    try {
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
    } catch (e) {}

    let targetPath = path.join(targetDir, safeName);
    let counter = 1;
    const ext = path.extname(safeName);
    const base = path.basename(safeName, ext);
    while (fs.existsSync(targetPath)) {
      targetPath = path.join(targetDir, `${base}_${counter}${ext}`);
      counter++;
    }

    const writeStream = fs.createWriteStream(targetPath);
    req.pipe(writeStream);

    writeStream.on('finish', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: targetPath, name: path.basename(targetPath) }));
    });

    writeStream.on('error', (err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  // QR Code generation API
  if (req.url.startsWith('/api/qr')) {
    let QRCode = null;
    try { QRCode = require('qrcode'); } catch (e) {}
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const text = urlObj.searchParams.get('url') || '';
    if (!text || !QRCode) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing url or QRCode module' }));
      return;
    }
    QRCode.toDataURL(text, { width: 280, margin: 1 }, (err, dataUrl) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ qr: dataUrl }));
    });
    return;
  }

  // Serve static files from web directory
  const webDir = process.env.CROSSDROP_WEB_DIR || path.resolve(__dirname, '..', 'web');
  let filePath = req.url.split('?')[0];
  if (filePath === '/') filePath = '/index.html';
  const fullPath = path.join(webDir, filePath);

  // Security check: ensure path is within web dir
  if (!path.resolve(fullPath).startsWith(webDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(fullPath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    const ext = path.extname(fullPath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.svg': 'image/svg+xml'
    };

    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(content);
  });
});

const wss = new WebSocketServer({ server });

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcastToRoom(pairKey, msg, excludeDeviceId = null) {
  const deviceIds = rooms.get(pairKey);
  if (!deviceIds) return;
  for (const id of deviceIds) {
    if (id === excludeDeviceId) continue;
    const client = clients.get(id);
    if (client) {
      send(client.ws, msg);
    }
  }
}

function getRoomPeers(pairKey, excludeDeviceId) {
  const deviceIds = rooms.get(pairKey);
  if (!deviceIds) return [];
  const list = [];
  for (const id of deviceIds) {
    if (id === excludeDeviceId) continue;
    const client = clients.get(id);
    if (client) {
      list.push({
        deviceId: client.deviceId,
        deviceName: client.deviceName,
        deviceType: client.deviceType,
        joinedAt: client.joinedAt
      });
    }
  }
  return list;
}

wss.on('connection', (ws, req) => {
  let currentDeviceId = null;
  let currentPairKey = null;

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      handleMessage(ws, msg);
    } catch (err) {
      console.error('[Signaling] Failed to parse message:', err.message);
    }
  });

  function handleMessage(ws, msg) {
    switch (msg.type) {
      case 'register': {
        const { deviceId, deviceName, deviceType, pairKey, pairCode } = msg;
        if (!deviceId) return;

        let resolvedPairKey = pairKey;
        // Check if joining with a 6-digit pin code
        if (!resolvedPairKey && pairCode) {
          const pinEntry = pinCodes.get(pairCode.trim());
          if (pinEntry) {
            resolvedPairKey = pinEntry.pairKey;
          } else {
            send(ws, { type: 'error', code: 'INVALID_PIN', message: 'Invalid or expired 6-digit pairing code' });
            return;
          }
        }

        if (!resolvedPairKey) {
          resolvedPairKey = 'default-room';
        }

        currentDeviceId = deviceId;
        currentPairKey = resolvedPairKey;

        // If client was previously registered with another key, remove it
        cleanupClient(deviceId);

        clients.set(deviceId, {
          ws,
          deviceId,
          deviceName: deviceName || 'Unknown Device',
          deviceType: deviceType || 'unknown',
          pairKey: resolvedPairKey,
          joinedAt: Date.now()
        });

        if (!rooms.has(resolvedPairKey)) {
          rooms.set(resolvedPairKey, new Set());
        }
        rooms.get(resolvedPairKey).add(deviceId);

        // Acknowledge registration
        send(ws, {
          type: 'registered',
          deviceId,
          pairKey: resolvedPairKey,
          peers: getRoomPeers(resolvedPairKey, deviceId)
        });

        // Notify other peers in the room
        broadcastToRoom(resolvedPairKey, {
          type: 'peer-joined',
          peer: {
            deviceId,
            deviceName: deviceName || 'Unknown Device',
            deviceType: deviceType || 'unknown'
          }
        }, deviceId);

        console.log(`[Signaling] Device registered: "${deviceName}" (${deviceId}) in room "${resolvedPairKey}"`);
        break;
      }

      case 'generate-pin': {
        // Generate a random 6-digit code linked to current pairKey
        if (!currentPairKey) return;
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        pinCodes.set(code, { pairKey: currentPairKey, createdAt: Date.now() });
        send(ws, { type: 'pin-generated', code, expiresInSeconds: 600 });
        console.log(`[Signaling] Generated pairing code ${code} for room ${currentPairKey}`);
        break;
      }

      case 'signal': {
        // Relay WebRTC Offer, Answer, or ICE Candidate
        const { targetId, data } = msg;
        if (!targetId || !data) return;

        const targetClient = clients.get(targetId);
        if (targetClient) {
          send(targetClient.ws, {
            type: 'signal',
            fromId: currentDeviceId,
            data
          });
        } else {
          send(ws, { type: 'peer-offline', targetId });
        }
        break;
      }

      case 'transfer-notify': {
        // Inform peer about pending file transfer (name, size, count)
        const { targetId, fileInfo } = msg;
        const targetClient = clients.get(targetId);
        if (targetClient) {
          send(targetClient.ws, {
            type: 'transfer-request',
            fromId: currentDeviceId,
            fileInfo
          });
        }
        break;
      }

      case 'transfer-response': {
        // Accepted or rejected
        const { targetId, accepted, transferId } = msg;
        const targetClient = clients.get(targetId);
        if (targetClient) {
          send(targetClient.ws, {
            type: 'transfer-response',
            fromId: currentDeviceId,
            accepted,
            transferId
          });
        }
        break;
      }

      case 'ping': {
        send(ws, { type: 'pong', timestamp: Date.now() });
        break;
      }
    }
  }

  function cleanupClient(id) {
    const client = clients.get(id);
    if (!client) return;

    clients.delete(id);
    const roomSet = rooms.get(client.pairKey);
    if (roomSet) {
      roomSet.delete(id);
      if (roomSet.size === 0) {
        rooms.delete(client.pairKey);
      } else {
        broadcastToRoom(client.pairKey, {
          type: 'peer-left',
          deviceId: id
        });
      }
    }
  }

  ws.on('close', () => {
    if (currentDeviceId) {
      console.log(`[Signaling] Device disconnected: ${currentDeviceId}`);
      cleanupClient(currentDeviceId);
    }
  });

  ws.on('error', (err) => {
    console.error('[Signaling] WebSocket error:', err.message);
  });
});

// Keepalive heartbeat
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

server.listen(PORT, HOST, () => {
  console.log(`===========================================`);
  console.log(`  CrossDrop Signaling Server is Running    `);
  console.log(`  HTTP/WS: http://${HOST}:${PORT}           `);
  console.log(`===========================================`);
});
