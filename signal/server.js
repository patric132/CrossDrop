/**
 * CrossDrop Signaling Server - Security Hardened
 * WebRTC signaling, pairing token authorization, and room isolation.
 */

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Security Logging (Never logs secrets, tokens, or file contents)
function logSecurity(event, details = {}) {
  const timestamp = new Date().toISOString();
  console.warn(`[SECURITY] [${timestamp}] ${event}:`, JSON.stringify(details));
}

// In-Memory Storage
// Map<deviceId, { ws, deviceId, deviceName, deviceType, roomId, joinedAt, ip }>
const clients = new Map();

// Map<roomId, { roomId, createdAt, hostDeviceId, allowedDevices: Set<deviceId> }>
const rooms = new Map();

// Map<token, { token, roomId, createdAt, expiresAt, status: 'pending'|'consumed' }>
const pairingTokens = new Map();

// Map<code, { code, roomId, createdAt, expiresAt, attempts: number }>
const pinCodes = new Map();

// Map<sessionToken, { sessionToken, deviceId, roomId, expiresAt }>
const sessionTokens = new Map();

// Rate Limiting Store: Map<ip, { msgCount, resetAt, failedPins, lockoutUntil }>
const rateLimits = new Map();

function getRateLimit(ip) {
  const now = Date.now();
  let entry = rateLimits.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = {
      msgCount: 0,
      resetAt: now + 60 * 1000,
      failedPins: entry?.failedPins || 0,
      lockoutUntil: entry?.lockoutUntil || 0
    };
    rateLimits.set(ip, entry);
  }
  return entry;
}

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = getRateLimit(ip);

  if (entry.lockoutUntil > now) {
    return { ok: false, reason: 'RATE_LIMIT_LOCKOUT' };
  }

  entry.msgCount++;
  if (entry.msgCount > 120) { // Max 120 messages per minute per IP
    return { ok: false, reason: 'RATE_LIMIT_EXCEEDED' };
  }
  return { ok: true };
}

// Periodic cleanup of expired tokens and rate limits
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of pairingTokens.entries()) {
    if (now > entry.expiresAt || entry.status === 'consumed') {
      pairingTokens.delete(token);
    }
  }
  for (const [code, entry] of pinCodes.entries()) {
    if (now > entry.expiresAt || entry.attempts >= 5) {
      pinCodes.delete(code);
    }
  }
  for (const [token, entry] of sessionTokens.entries()) {
    if (now > entry.expiresAt) {
      sessionTokens.delete(token);
    }
  }
  for (const [ip, entry] of rateLimits.entries()) {
    if (now > entry.resetAt && now > entry.lockoutUntil) {
      rateLimits.delete(ip);
    }
  }
}, 30 * 1000);

// Helper: CSPRNG generation
function generateSecureToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function generateSecurePIN() {
  return crypto.randomInt(100000, 1000000).toString();
}

// HTTP Server
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Filename');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // P2-1: Minimized /health endpoint
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Loopback-only API: Generate new pairing token for local Mac Host
  if (req.method === 'POST' && req.url === '/api/create-session') {
    const isFromCloudflare = req.headers['cf-ray'] || req.headers['cf-connecting-ip'];
    const ip = req.socket.remoteAddress || '';
    const isLoopback = ip.includes('127.0.0.1') || ip === '::1' || ip === '::ffff:127.0.0.1';

    if (isFromCloudflare || !isLoopback) {
      logSecurity('UNAUTHORIZED_LOCAL_ENDPOINT', { endpoint: '/api/create-session', ip });
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Access denied: Local loopback only' }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = body ? JSON.parse(body) : {};
        const roomId = (typeof data.roomId === 'string' && data.roomId.length >= 16 && data.roomId.length <= 128)
          ? data.roomId
          : generateSecureToken(16);

        if (!rooms.has(roomId)) {
          rooms.set(roomId, {
            roomId,
            createdAt: Date.now(),
            hostDeviceId: data.deviceId || 'mac-host',
            allowedDevices: new Set([data.deviceId || 'mac-host'])
          });
        }

        const ttlMs = (typeof data.ttlSeconds === 'number') ? Math.floor(data.ttlSeconds * 1000) : 10 * 60 * 1000;

        // Generate one-time Pairing Token
        const token = generateSecureToken(32);
        pairingTokens.set(token, {
          token,
          roomId,
          createdAt: Date.now(),
          expiresAt: Date.now() + ttlMs,
          status: 'pending'
        });

        // Generate PIN
        const pin = generateSecurePIN();
        pinCodes.set(pin, {
          code: pin,
          roomId,
          createdAt: Date.now(),
          expiresAt: Date.now() + ttlMs,
          attempts: 0
        });

        logSecurity('PAIRING_TOKEN_GENERATED', { roomId });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          roomId,
          token,
          pairingToken: token,
          pin,
          expiresInSeconds: 600
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      }
    });
    return;
  }

  // Direct file save endpoint for Mac (stream file directly to Documents/CrossDrop_Received)
  // SECURITY: Strictly restrict to Mac local loopback; reject any external requests from Cloudflare Tunnel
  if (req.method === 'POST' && req.url === '/api/save-file') {
    const isFromCloudflare = req.headers['cf-ray'] || req.headers['cf-connecting-ip'];
    const ip = req.socket.remoteAddress || '';
    const isLoopback = ip.includes('127.0.0.1') || ip === '::1' || ip === '::ffff:127.0.0.1';

    if (isFromCloudflare || !isLoopback) {
      logSecurity('FORBIDDEN_EXTERNAL_SAVE_FILE', { ip });
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Access denied: Local loopback only' }));
      return;
    }

    const rawName = decodeURIComponent(req.headers['x-filename'] || 'received_file');
    // Sanitize: no path traversal, no script tags, no invalid chars
    const cleaned = rawName.replace(/<[^>]*>/g, '').replace(/script/gi, '');
    const safeName = path.basename(cleaned).replace(/[/\\?%*:|"<>]/g, '_') || 'received_file';
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

  if (!path.resolve(fullPath).startsWith(webDir)) {
    logSecurity('PATH_TRAVERSAL_ATTEMPT', { path: filePath });
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
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.aiff': 'audio/aiff'
    };

    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(content);
  });
});

// P1-3: Limit single WebSocket message to 64 KB (maxPayload: 64 * 1024)
const wss = new WebSocketServer({
  server,
  maxPayload: 64 * 1024
});

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcastToRoom(roomId, msg, excludeDeviceId = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const id of room.allowedDevices) {
    if (id === excludeDeviceId) continue;
    const client = clients.get(id);
    if (client && client.ws) {
      send(client.ws, msg);
    }
  }
}

function getRoomPeers(roomId, excludeDeviceId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  const list = [];
  for (const id of room.allowedDevices) {
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

// P0-6: Complete WebSocket Message Validation
const ALLOWED_TYPES = new Set([
  'register',
  'create-room',
  'generate-token',
  'generate-pin',
  'verify-pin',
  'signal',
  'ping'
]);

function validateMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return { ok: false, error: 'Message must be a non-null object' };
  }
  if (typeof msg.type !== 'string' || !ALLOWED_TYPES.has(msg.type)) {
    return { ok: false, error: `Invalid or disallowed message type: ${msg.type}` };
  }

  // String field boundaries
  const stringFields = ['deviceId', 'deviceName', 'deviceType', 'roomId', 'token', 'pin', 'sessionToken', 'targetId', 'pairKey'];
  for (const field of stringFields) {
    if (msg[field] !== undefined) {
      if (typeof msg[field] !== 'string') {
        return { ok: false, error: `Field '${field}' must be a string` };
      }
      if (msg[field].length > 128) {
        return { ok: false, error: `Field '${field}' exceeds maximum length of 128 characters` };
      }
    }
  }

  // Special checks
  if (msg.type === 'signal') {
    if (!msg.targetId || typeof msg.targetId !== 'string') {
      return { ok: false, error: 'Signal message requires valid targetId' };
    }
    if (!msg.data || typeof msg.data !== 'object') {
      return { ok: false, error: 'Signal message requires valid data object' };
    }
  }

  return { ok: true };
}

wss.on('connection', (ws, req) => {
  const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown';
  let currentDeviceId = null;
  let currentRoomId = null;

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    // P1-2: WebSocket Rate Limit Check
    const rateCheck = checkRateLimit(ip);
    if (!rateCheck.ok) {
      logSecurity('RATE_LIMIT_BLOCKED', { ip, reason: rateCheck.reason });
      send(ws, {
        type: 'error',
        code: 'RATE_LIMIT',
        message: 'Too many requests. Please slow down.'
      });
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      logSecurity('INVALID_JSON', { ip, error: err.message });
      send(ws, { type: 'error', code: 'INVALID_JSON', message: 'Malformed JSON message' });
      return;
    }

    // P0-6: Schema & Type Validation
    const validation = validateMessage(msg);
    if (!validation.ok) {
      logSecurity('INVALID_MESSAGE', { ip, error: validation.error });
      send(ws, { type: 'error', code: 'INVALID_MESSAGE', message: validation.error });
      return;
    }

    handleMessage(ws, msg, ip);
  });

  function handleMessage(ws, msg, ip) {
    switch (msg.type) {
      // Create a new secure room (used by host, e.g. Mac)
      case 'create-room': {
        const { deviceId, deviceName, deviceType, customRoomId } = msg;
        if (!deviceId) {
          send(ws, { type: 'error', code: 'INVALID_DEVICE', message: 'deviceId is required' });
          return;
        }

        // Room ID is either user-provided custom secure string or generated 256-bit CSPRNG
        const roomId = (typeof customRoomId === 'string' && customRoomId.length >= 8 && customRoomId.length <= 128)
          ? customRoomId
          : generateSecureToken(16);

        const roomSecret = generateSecureToken(32);
        rooms.set(roomId, {
          roomId,
          secret: roomSecret,
          createdAt: Date.now(),
          hostDeviceId: deviceId,
          allowedDevices: new Set([deviceId])
        });

        // Issue host session token
        const hostSessionToken = generateSecureToken(32);
        sessionTokens.set(hostSessionToken, {
          sessionToken: hostSessionToken,
          deviceId,
          roomId,
          expiresAt: Date.now() + 24 * 60 * 60 * 1000 // 24h session
        });

        // Register client in room
        currentDeviceId = deviceId;
        currentRoomId = roomId;
        cleanupClient(deviceId);

        clients.set(deviceId, {
          ws,
          deviceId,
          deviceName: (deviceName || 'Mac Device').slice(0, 64),
          deviceType: deviceType || 'mac',
          roomId,
          joinedAt: Date.now(),
          ip
        });

        logSecurity('ROOM_CREATED', { roomId });
        send(ws, {
          type: 'room-created',
          roomId,
          sessionToken: hostSessionToken
        });
        break;
      }

      // Generate a one-time Pairing Token for the room (P0-2, P1-6)
      case 'generate-token': {
        if (!currentRoomId || !rooms.has(currentRoomId)) {
          send(ws, { type: 'error', code: 'UNAUTHORIZED', message: 'Must create or join a room first' });
          return;
        }

        const token = generateSecureToken(32); // 256-bit entropy
        pairingTokens.set(token, {
          token,
          roomId: currentRoomId,
          createdAt: Date.now(),
          expiresAt: Date.now() + 10 * 60 * 1000, // 10 mins
          status: 'pending'
        });

        logSecurity('TOKEN_ISSUED', { roomId: currentRoomId });
        send(ws, {
          type: 'token-generated',
          token,
          expiresInSeconds: 600
        });
        break;
      }

      // Generate a 6-digit PIN for the room (P1-1, P1-5)
      case 'generate-pin': {
        if (!currentRoomId || !rooms.has(currentRoomId)) {
          send(ws, { type: 'error', code: 'UNAUTHORIZED', message: 'Must create or join a room first' });
          return;
        }

        const code = generateSecurePIN();
        pinCodes.set(code, {
          code,
          roomId: currentRoomId,
          createdAt: Date.now(),
          expiresAt: Date.now() + 10 * 60 * 1000, // 10 mins
          attempts: 0
        });

        logSecurity('PIN_GENERATED', { roomId: currentRoomId });
        send(ws, {
          type: 'pin-generated',
          code,
          expiresInSeconds: 600
        });
        break;
      }

      // Register / Join Room with Token, SessionToken, or PIN (P0-1, P0-2, P1-5, P1-6)
      case 'register': {
        const { deviceId, deviceName, deviceType, token, pin, sessionToken, roomId } = msg;
        if (!deviceId) {
          send(ws, { type: 'error', code: 'INVALID_DEVICE', message: 'deviceId is required' });
          return;
        }

        let targetRoomId = null;

        // Check rate lockout for IP
        const rateEntry = getRateLimit(ip);
        if (rateEntry.lockoutUntil && Date.now() < rateEntry.lockoutUntil) {
          logSecurity('PIN_LOCKED_ATTEMPT', { ip, deviceId });
          send(ws, { type: 'error', code: 'PIN_LOCKED', message: 'Too many failed PIN attempts. Locked out for 15 minutes.' });
          return;
        }

        const effectiveToken = token || (typeof msg.pairKey === 'string' && msg.pairKey.length >= 32 ? msg.pairKey.trim() : null);
        const effectivePin = pin || (typeof msg.pairKey === 'string' && /^\d{6}$/.test(msg.pairKey.trim()) ? msg.pairKey.trim() : null);

        // Path A: Authenticate via Session Token (existing authorized device reconnecting)
        if (sessionToken && sessionTokens.has(sessionToken)) {
          const sess = sessionTokens.get(sessionToken);
          if (Date.now() <= sess.expiresAt && sess.deviceId === deviceId) {
            targetRoomId = sess.roomId;
            logSecurity('PAIRING_SUCCESS_SESSION', { deviceId, roomId: targetRoomId });
          } else {
            sessionTokens.delete(sessionToken);
            logSecurity('INVALID_SESSION_TOKEN', { deviceId });
          }
        }

        // Path B: Authenticate via One-Time Pairing Token (P0-2, P1-6)
        if (!targetRoomId && effectiveToken) {
          const tokEntry = pairingTokens.get(effectiveToken);
          if (tokEntry) {
            if (Date.now() > tokEntry.expiresAt) {
              pairingTokens.delete(effectiveToken);
              logSecurity('EXPIRED_TOKEN', { deviceId });
              send(ws, { type: 'error', code: 'EXPIRED_TOKEN', message: 'Pairing token has expired' });
              return;
            } else if (tokEntry.status === 'consumed') {
              logSecurity('CONSUMED_TOKEN_REUSE', { deviceId });
              send(ws, { type: 'error', code: 'TOKEN_ALREADY_USED', message: 'Pairing token has already been used' });
              return;
            } else {
              // Mark token consumed immediately (one-time use)
              tokEntry.status = 'consumed';
              targetRoomId = tokEntry.roomId;
              pairingTokens.delete(effectiveToken);
              logSecurity('PAIRING_SUCCESS_TOKEN', { deviceId, roomId: targetRoomId });
            }
          } else {
            logSecurity('INVALID_TOKEN', { deviceId, ip });
            send(ws, { type: 'error', code: 'INVALID_TOKEN', message: 'Invalid pairing token' });
            return;
          }
        }

        // Path C: Authenticate via 6-digit PIN (P1-5)
        if (!targetRoomId && effectivePin) {
          const cleanPin = effectivePin.trim();
          const pinEntry = pinCodes.get(cleanPin);

          if (pinEntry) {
            if (Date.now() > pinEntry.expiresAt) {
              pinCodes.delete(cleanPin);
              logSecurity('EXPIRED_PIN', { deviceId });
              send(ws, { type: 'error', code: 'EXPIRED_PIN', message: 'PIN code has expired' });
              return;
            }

            pinEntry.attempts++;
            if (pinEntry.attempts > 5) {
              pinCodes.delete(cleanPin);
              rateEntry.lockoutUntil = Date.now() + 15 * 60 * 1000; // 15-min lockout
              logSecurity('PIN_BRUTE_FORCE_LOCKOUT', { ip, deviceId });
              send(ws, { type: 'error', code: 'PIN_LOCKED', message: 'Too many failed PIN attempts. Locked out for 15 minutes.' });
              return;
            }

            // PIN verified successfully! Invalidate PIN immediately
            targetRoomId = pinEntry.roomId;
            pinCodes.delete(cleanPin);
            rateEntry.failedPins = 0;
            logSecurity('PAIRING_SUCCESS_PIN', { deviceId, roomId: targetRoomId });
          } else {
            rateEntry.failedPins++;
            if (rateEntry.failedPins >= 5) {
              rateEntry.lockoutUntil = Date.now() + 15 * 60 * 1000;
              logSecurity('PIN_BRUTE_FORCE_LOCKOUT', { ip });
              send(ws, { type: 'error', code: 'PIN_LOCKED', message: 'Too many failed PIN attempts. Locked out for 15 minutes.' });
              return;
            }
            logSecurity('INVALID_PIN', { ip, attempts: rateEntry.failedPins });
            send(ws, { type: 'error', code: 'INVALID_PIN', message: `Invalid PIN code (${5 - rateEntry.failedPins} attempts left)` });
            return;
          }
        }

        // Path D: Direct Room ID join (if room was previously created and allowed)
        if (!targetRoomId && roomId && rooms.has(roomId)) {
          const room = rooms.get(roomId);
          if (room.allowedDevices.has(deviceId)) {
            targetRoomId = roomId;
            logSecurity('PAIRING_SUCCESS_REJOIN', { deviceId, roomId });
          }
        }

        // P0-1 & P0-2: No default room permitted! Unauthenticated clients are strictly REJECTED
        if (!targetRoomId || !rooms.has(targetRoomId)) {
          logSecurity('UNAUTHORIZED_REGISTER', { deviceId, ip });
          send(ws, {
            type: 'error',
            code: 'UNAUTHORIZED',
            message: 'Authentication required. Please scan QR Code or enter valid PIN to connect.'
          });
          return;
        }

        // Register client to authorized room
        currentDeviceId = deviceId;
        currentRoomId = targetRoomId;
        cleanupClient(deviceId);

        const room = rooms.get(targetRoomId);
        room.allowedDevices.add(deviceId);

        // Issue new session token for reconnection
        const newSessionToken = generateSecureToken(32);
        sessionTokens.set(newSessionToken, {
          sessionToken: newSessionToken,
          deviceId,
          roomId: targetRoomId,
          expiresAt: Date.now() + 24 * 60 * 60 * 1000
        });

        clients.set(deviceId, {
          ws,
          deviceId,
          deviceName: (deviceName || 'Unknown Device').slice(0, 64),
          deviceType: deviceType || 'unknown',
          roomId: targetRoomId,
          joinedAt: Date.now(),
          ip
        });

        // Confirm registration
        send(ws, {
          type: 'registered',
          deviceId,
          roomId: targetRoomId,
          sessionToken: newSessionToken,
          peers: getRoomPeers(targetRoomId, deviceId)
        });

        // Notify other room peers
        broadcastToRoom(targetRoomId, {
          type: 'peer-joined',
          peer: {
            deviceId,
            deviceName: (deviceName || 'Unknown Device').slice(0, 64),
            deviceType: deviceType || 'unknown'
          }
        }, deviceId);

        console.log(`[Signaling] Device authorized & joined: "${deviceName}" (${deviceId}) in room "${targetRoomId}"`);
        break;
      }

      // P0-5: Block Cross-Room Signaling
      case 'signal': {
        const { targetId, data } = msg;
        if (!targetId || !data) return;

        const sender = clients.get(currentDeviceId);
        const target = clients.get(targetId);

        if (!sender || !sender.roomId) {
          send(ws, { type: 'error', code: 'UNAUTHORIZED', message: 'Sender not authenticated in a room' });
          return;
        }

        if (!target) {
          send(ws, { type: 'peer-offline', targetId });
          return;
        }

        // STRICT ROOM CHECK: sender and target MUST belong to the EXACT same room!
        if (target.roomId !== sender.roomId) {
          logSecurity('CROSS_ROOM_SIGNAL', {
            senderId: currentDeviceId,
            senderRoom: sender.roomId,
            targetId,
            targetRoom: target.roomId
          });
          send(ws, {
            type: 'error',
            code: 'CROSS_ROOM_DENIED',
            message: 'Cross-room signaling is strictly forbidden'
          });
          return;
        }

        // Relayed signal within the authorized room
        send(target.ws, {
          type: 'signal',
          fromId: currentDeviceId,
          data
        });
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
    const room = rooms.get(client.roomId);
    if (room) {
      broadcastToRoom(client.roomId, {
        type: 'peer-left',
        deviceId: id
      }, id);
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
  console.log(`  CrossDrop Security-Hardened Signaling    `);
  console.log(`  HTTP/WS: http://${HOST}:${PORT}           `);
  console.log(`===========================================`);
});
