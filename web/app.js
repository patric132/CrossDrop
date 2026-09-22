/**
 * CrossDrop WebRTC P2P Engine & UI Controller (Security-Hardened)
 */

// Configuration & Security Boundaries
const CHUNK_SIZE = 64 * 1024; // 64 KB per chunk
const BUFFER_THRESHOLD = 1024 * 1024; // 1 MB backpressure threshold
const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024; // P0-4: 10 GB Maximum file size limit
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ]
};

// P1-1: CSPRNG ID Generator
function generateSecureId(prefix = 'id') {
  if (window.crypto && window.crypto.randomUUID) {
    return prefix + '-' + window.crypto.randomUUID();
  }
  const arr = new Uint8Array(8);
  window.crypto.getRandomValues(arr);
  return prefix + '-' + Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

// Filename Sanitizer (Path Traversal & Control Char Defense)
function sanitizeFilename(filename) {
  if (!filename || typeof filename !== 'string') return 'received_file';
  // Remove HTML script tags and script tokens
  let clean = filename.replace(/<[^>]*>/g, '').replace(/script/gi, '');
  // Remove path traversal and directory separators
  clean = clean.replace(/^[a-zA-Z]:/, '').split(/[\/\\]/).pop() || 'received_file';
  // Remove control characters (0x00-0x1F, 0x7F) and unsafe characters
  clean = clean.replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_');
  // Strip dangerous leading/trailing dots or spaces
  clean = clean.replace(/^\.+/, '').trim();
  if (!clean || clean === '..') clean = 'received_file';
  // Enforce max length 255
  if (clean.length > 255) {
    const ext = clean.lastIndexOf('.') > 0 ? clean.slice(clean.lastIndexOf('.')) : '';
    clean = clean.slice(0, 255 - ext.length) + ext;
  }
  return clean;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// State
let ws = null;
let deviceId = localStorage.getItem('crossdrop_device_id') || generateSecureId('dev');
localStorage.setItem('crossdrop_device_id', deviceId);

let deviceName = localStorage.getItem('crossdrop_device_name') || detectDeviceName();
let sessionToken = localStorage.getItem('crossdrop_session_token') || null;
let roomId = localStorage.getItem('crossdrop_room_id') || null;
let currentPairingToken = null;
let currentPin = null;
let publicTunnelUrl = null;
let localWifiUrl = null;
let tokenGeneratedAt = 0;

let peers = new Map(); // targetId -> { deviceId, deviceName, deviceType }
let selectedPeerId = null;
let peerConnections = new Map(); // targetId -> RTCPeerConnection
let dataChannels = new Map(); // targetId -> RTCDataChannel
const pendingAcks = new Map(); // transferId -> resolveFunction
const pendingTransferConsents = new Map(); // transferId -> { resolve, reject, timer }

// Active file transfers & Consent state
let currentPendingConsent = null; // Incoming transfer consent request awaiting UI confirm
let consentCountdownTimer = null;
let currentSending = null;
let currentReceiving = null;

// DOM Elements
const elStatusDot = document.getElementById('status-dot');
const elStatusText = document.getElementById('status-text');
const elMyDeviceName = document.getElementById('my-device-name');
const elPeersContainer = document.getElementById('peers-container');
const elDropZone = document.getElementById('drop-zone');
const elFileInput = document.getElementById('file-input');
const elTransferCard = document.getElementById('transfer-card');
const elTransferTitle = document.getElementById('transfer-title');
const elProgressBar = document.getElementById('progress-bar');
const elTransferPercent = document.getElementById('transfer-percent');
const elTransferSpeed = document.getElementById('transfer-speed');
const elTransferRemaining = document.getElementById('transfer-remaining');
const elReceivedList = document.getElementById('received-list');

// Security UI Elements
const elPinEntryCard = document.getElementById('pin-entry-card');
const elPinInput = document.getElementById('pin-input');
const elBtnSubmitPin = document.getElementById('btn-submit-pin');
const elPinErrorText = document.getElementById('pin-error-text');
const elHostPairingCard = document.getElementById('host-pairing-card');
const elDisplayPinCode = document.getElementById('display-pin-code');
const elBtnRefreshPin = document.getElementById('btn-refresh-pin');

// Transfer Consent Modal Elements
const elTransferModal = document.getElementById('transfer-modal');
const elTransferModalFrom = document.getElementById('transfer-modal-from');
const elTransferModalFilename = document.getElementById('transfer-modal-filename');
const elTransferModalFilesize = document.getElementById('transfer-modal-filesize');
const elTransferModalCountdown = document.getElementById('transfer-modal-countdown');
const elBtnTransferAccept = document.getElementById('btn-transfer-accept');
const elBtnTransferReject = document.getElementById('btn-transfer-reject');

function isMacHost() {
  return Boolean(
    (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.crossdropNative) ||
    location.hostname === 'localhost' ||
    location.hostname === '127.0.0.1'
  );
}

// Initialize
function init() {
  elMyDeviceName.textContent = deviceName;

  if (isMacHost()) {
    if (elHostPairingCard) elHostPairingCard.style.display = 'block';
    if (elPinEntryCard) elPinEntryCard.style.display = 'none';

    // Discover local Wi-Fi IP for direct LAN fallback
    fetch('/api/network-info')
      .then(res => res.json())
      .then(data => {
        if (data && data.ips && data.ips.length > 0) {
          localWifiUrl = `http://${data.ips[0]}:${data.port || 3000}`;
          updateLocalWifiBanner();
        }
      })
      .catch(() => {});

    // Periodic token & PIN heartbeat (every 10 minutes) so credentials never expire
    setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'generate-token' }));
        ws.send(JSON.stringify({ type: 'generate-pin' }));
      }
    }, 10 * 60 * 1000);
  } else {
    if (elHostPairingCard) elHostPairingCard.style.display = 'none';
  }

  connectSignaling();
  setupEventListeners();
}

function detectDeviceName() {
  const ua = navigator.userAgent;
  let name = 'Web Client';
  if (/Macintosh/i.test(ua)) name = 'MacBook Pro';
  else if (/Android/i.test(ua)) name = 'Android Phone';
  else if (/iPhone|iPad/i.test(ua)) name = 'iOS Device';
  else if (/Windows/i.test(ua)) name = 'Windows PC';
  return name;
}

function getDeviceType() {
  const ua = navigator.userAgent;
  if (/Macintosh/i.test(ua)) return 'mac';
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad/i.test(ua)) return 'ios';
  return 'pc';
}

// WebSocket Signaling
function connectSignaling() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host || 'localhost:3000';
  const wsUrl = `${protocol}//${host}`;

  elStatusText.textContent = 'Connecting...';
  elStatusDot.className = 'status-dot';

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    const urlParams = new URLSearchParams(window.location.search);
    const urlToken = urlParams.get('token');

    if (urlToken) {
      // Mobile joined via one-time pairing token link / QR code
      elStatusText.textContent = 'Authenticating...';
      ws.send(JSON.stringify({
        type: 'register',
        deviceId,
        deviceName,
        deviceType: getDeviceType(),
        token: urlToken
      }));
      // Clean token parameter from address bar
      try {
        window.history.replaceState({}, document.title, window.location.pathname);
      } catch (e) {}
    } else if (sessionToken) {
      // Reconnecting with existing session token
      elStatusText.textContent = 'Reconnecting...';
      ws.send(JSON.stringify({
        type: 'register',
        deviceId,
        deviceName,
        deviceType: getDeviceType(),
        sessionToken
      }));
    } else if (isMacHost()) {
      // Local Mac Host creates its secure room
      elStatusText.textContent = 'Creating Secure Room...';
      ws.send(JSON.stringify({
        type: 'create-room',
        deviceId,
        deviceName: 'MacBook Pro',
        deviceType: 'mac'
      }));
    } else {
      // Mobile visitor without token -> prompt for PIN code
      elStatusText.textContent = 'Authentication Required';
      showPinEntryUI('請輸入 Mac 顯示的 6 位數配對碼');
    }
  };

  ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleSignalingMessage(msg);
    } catch (e) {
      console.error('Signaling parse error:', e);
    }
  };

  ws.onclose = () => {
    elStatusText.textContent = 'Reconnecting...';
    elStatusDot.className = 'status-dot';
    setTimeout(connectSignaling, 3000);
  };

  ws.onerror = () => {
    ws.close();
  };
}

async function handleSignalingMessage(msg) {
  switch (msg.type) {
    case 'room-created': {
      roomId = msg.roomId;
      sessionToken = msg.sessionToken;
      localStorage.setItem('crossdrop_room_id', roomId);
      localStorage.setItem('crossdrop_session_token', sessionToken);
      elStatusText.textContent = 'Room Active (Hosting)';
      elStatusDot.className = 'status-dot connected';

      // Request pairing token and 6-digit PIN for guests
      ws.send(JSON.stringify({ type: 'generate-token' }));
      ws.send(JSON.stringify({ type: 'generate-pin' }));
      break;
    }

    case 'token-generated': {
      currentPairingToken = msg.token;
      tokenGeneratedAt = Date.now();
      updatePublicUrlBanner();
      updateLocalWifiBanner();
      const qrModal = document.getElementById('qr-modal');
      if (qrModal && qrModal.style.display === 'block') {
        renderQrCode();
      }
      break;
    }

    case 'pin-generated': {
      currentPin = msg.code;
      if (elDisplayPinCode) {
        elDisplayPinCode.textContent = msg.code;
      }
      break;
    }

    case 'registered': {
      if (msg.sessionToken) {
        sessionToken = msg.sessionToken;
        localStorage.setItem('crossdrop_session_token', sessionToken);
      }
      if (msg.roomId) {
        roomId = msg.roomId;
        localStorage.setItem('crossdrop_room_id', roomId);
      }

      elStatusText.textContent = 'Connected (Paired)';
      elStatusDot.className = 'status-dot connected';

      peers.clear();
      if (msg.peers) {
        msg.peers.forEach(p => peers.set(p.deviceId, p));
      }
      renderPeers();
      hidePinEntryUI();
      break;
    }

    case 'peer-joined': {
      peers.set(msg.peer.deviceId, msg.peer);
      renderPeers();
      break;
    }

    case 'peer-left': {
      peers.delete(msg.deviceId);
      cleanupPeerConnection(msg.deviceId);
      renderPeers();
      break;
    }

    case 'signal': {
      const { fromId, data } = msg;
      await handlePeerSignal(fromId, data);
      break;
    }

    case 'error': {
      console.warn('[Signaling Error]', msg.code, msg.message);
      if (msg.code === 'UNAUTHORIZED' || msg.code === 'INVALID_TOKEN' || msg.code === 'EXPIRED_TOKEN') {
        localStorage.removeItem('crossdrop_session_token');
        sessionToken = null;
        showPinEntryUI('⚠️ 配對連結已逾期或無效，請直接輸入 Mac 螢幕上顯示的 6 位數 PIN 碼：');
      } else if (msg.code === 'INVALID_PIN' || msg.code === 'PIN_LOCKED') {
        showPinError(msg.message);
      } else {
        alert(`[CrossDrop Alert] ${msg.message}`);
      }
      break;
    }
  }
}

// PIN Entry UI Helpers
function showPinEntryUI(hintText) {
  if (isMacHost()) return;
  if (elPinEntryCard) {
    elPinEntryCard.style.display = 'block';
    if (elPinErrorText) {
      if (hintText) {
        elPinErrorText.textContent = hintText;
        elPinErrorText.style.color = 'var(--text-sub)';
        elPinErrorText.style.display = 'block';
      } else {
        elPinErrorText.style.display = 'none';
      }
    }
    if (elPinInput) {
      elPinInput.focus();
    }
  }
}

function hidePinEntryUI() {
  if (elPinEntryCard) {
    elPinEntryCard.style.display = 'none';
  }
  if (elPinErrorText) {
    elPinErrorText.style.display = 'none';
  }
}

function showPinError(err) {
  if (elPinErrorText) {
    elPinErrorText.textContent = err;
    elPinErrorText.style.color = '#ff453a';
    elPinErrorText.style.display = 'block';
  }
}

// WebRTC Peer Management
function getOrCreatePeerConnection(targetId) {
  let pc = peerConnections.get(targetId);
  if (pc && pc.signalingState !== 'closed' && pc.connectionState !== 'failed') {
    return pc;
  }
  if (pc) {
    cleanupPeerConnection(targetId);
  }

  pc = new RTCPeerConnection(RTC_CONFIG);
  pc._pendingCandidates = [];

  pc.onicecandidate = (event) => {
    if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'signal',
        targetId,
        data: { candidate: event.candidate }
      }));
    }
  };

  pc.ondatachannel = (event) => {
    setupDataChannel(targetId, event.channel);
  };

  pc.onconnectionstatechange = () => {
    console.log(`[WebRTC] Connection state with ${targetId}: ${pc.connectionState}`);
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      cleanupPeerConnection(targetId);
      renderPeers();
    }
  };

  peerConnections.set(targetId, pc);
  return pc;
}

function cleanupPeerConnection(targetId) {
  const dc = dataChannels.get(targetId);
  if (dc) {
    try { dc.close(); } catch (e) {}
    dataChannels.delete(targetId);
  }
  const pc = peerConnections.get(targetId);
  if (pc) {
    try { pc.close(); } catch (e) {}
    peerConnections.delete(targetId);
  }
  if (selectedPeerId === targetId) {
    selectedPeerId = null;
  }
}

async function handlePeerSignal(fromId, data) {
  const pc = getOrCreatePeerConnection(fromId);

  if (data.sdp) {
    await pc.setRemoteDescription(new RTCSessionDescription(data));

    if (pc._pendingCandidates && pc._pendingCandidates.length > 0) {
      for (const candidate of pc._pendingCandidates) {
        try {
          await pc.addIceCandidate(candidate);
        } catch (e) {
          console.warn('Error adding queued candidate:', e);
        }
      }
      pc._pendingCandidates = [];
    }

    if (data.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'signal',
          targetId: fromId,
          data: { sdp: pc.localDescription.sdp, type: 'answer' }
        }));
      }
    }
  } else if (data.candidate) {
    const iceCandidate = new RTCIceCandidate(data.candidate);
    if (pc.remoteDescription && pc.remoteDescription.type) {
      try {
        await pc.addIceCandidate(iceCandidate);
      } catch (e) {
        console.warn('Failed to add candidate:', e);
      }
    } else {
      pc._pendingCandidates = pc._pendingCandidates || [];
      pc._pendingCandidates.push(iceCandidate);
    }
  }
}

async function ensureDataChannel(targetId) {
  let dc = dataChannels.get(targetId);
  if (dc && dc.readyState === 'open') {
    return dc;
  }

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connectSignaling();
    await new Promise((resolve) => {
      let attempts = 0;
      const checkWs = setInterval(() => {
        attempts++;
        if (ws && ws.readyState === WebSocket.OPEN) {
          clearInterval(checkWs);
          resolve();
        } else if (attempts > 30) {
          clearInterval(checkWs);
          resolve();
        }
      }, 100);
    });
  }

  const pc = getOrCreatePeerConnection(targetId);
  dc = pc.createDataChannel('crossdrop-files', { ordered: true });
  setupDataChannel(targetId, dc);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  ws.send(JSON.stringify({
    type: 'signal',
    targetId,
    data: { sdp: pc.localDescription.sdp, type: 'offer' }
  }));

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('連線逾時（35秒未回應）。請確認兩端螢幕均開啟且處於 CrossDrop 畫面。'));
    }, 35000);
    dc.onopen = () => {
      clearTimeout(timeout);
      resolve(dc);
    };
  });
}

function setupDataChannel(targetId, dc) {
  dc.binaryType = 'arraybuffer';

  dc.onopen = () => {
    console.log(`[DataChannel] Connected to ${targetId}`);
    dataChannels.set(targetId, dc);
    renderPeers();
  };

  dc.onclose = () => {
    console.log(`[DataChannel] Disconnected from ${targetId}`);
    dataChannels.delete(targetId);
    renderPeers();
  };

  dc.onmessage = (event) => {
    handleIncomingData(event.data, targetId, dc);
  };
}

// DataChannel Message & File Reception Logic
function handleIncomingData(data, senderId, dc) {
  if (typeof data === 'string') {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (err) {
      console.warn('Malformed DataChannel message:', err);
      return;
    }

    // P0-3: Sender receives transfer acceptance from receiver
    if (msg.type === 'transfer-accept') {
      const consent = pendingTransferConsents.get(msg.transferId);
      if (consent) {
        pendingTransferConsents.delete(msg.transferId);
        consent.resolve();
      }
      return;
    }

    // P0-3: Sender receives transfer rejection from receiver
    if (msg.type === 'transfer-reject') {
      const consent = pendingTransferConsents.get(msg.transferId);
      if (consent) {
        pendingTransferConsents.delete(msg.transferId);
        consent.reject(new Error(msg.reason || '對方拒絕接收此檔案'));
      }
      return;
    }

    // P0-3: Receiver handles incoming Transfer Consent Request
    if (msg.type === 'transfer-request') {
      handleIncomingTransferRequest(msg, senderId, dc);
      return;
    }

    // Per-file ACK
    if (msg.type === 'file-ack') {
      const resolveAck = pendingAcks.get(msg.id);
      if (resolveAck) {
        pendingAcks.delete(msg.id);
        resolveAck();
      }
      return;
    }

    // Header starting stream
    if (msg.type === 'header') {
      if (currentReceiving && currentReceiving.id === msg.id && currentReceiving.accepted) {
        currentReceiving.totalChunks = msg.totalChunks;
        showTransferUI(`Receiving: ${currentReceiving.name}`);
      }
      return;
    }

    // Stream finished
    if (msg.type === 'done') {
      if (currentReceiving && currentReceiving.id === msg.id && currentReceiving.accepted) {
        const finishedRec = currentReceiving;
        currentReceiving = null;
        completeReception(finishedRec).then(() => {
          try {
            if (dc && dc.readyState === 'open') {
              dc.send(JSON.stringify({ type: 'file-ack', id: msg.id }));
            }
          } catch (err) {
            console.warn('Failed to send file-ack:', err);
          }
        });
      }
      return;
    }
  } else if (data instanceof ArrayBuffer) {
    // P0-3: Binary chunks MUST NOT be accepted without explicit transfer consent!
    if (!currentReceiving || !currentReceiving.accepted) {
      console.warn('[Security] Unauthorized binary chunk dropped without transfer consent!');
      return;
    }

    // P0-4: Buffer Overflow & File Size Attack Guard
    currentReceiving.receivedBytes += data.byteLength;
    if (currentReceiving.receivedBytes > currentReceiving.size) {
      console.error('[Security] Transfer aborted: receivedBytes exceeds declared file size!');
      currentReceiving = null;
      hideTransferUI();
      alert('資安警告：接收到的檔案資料超出申報大小，傳輸已強制中止！');
      return;
    }

    currentReceiving.chunks.push(data);
    updateProgress(currentReceiving.receivedBytes, currentReceiving.size, currentReceiving.startTime);
  }
}

// P0-3: Transfer Consent UI & Modal Handling
function handleIncomingTransferRequest(req, senderId, dc) {
  // P0-4: Validate file size boundary
  if (typeof req.size !== 'number' || !Number.isSafeInteger(req.size) || req.size < 0 || req.size > MAX_FILE_SIZE) {
    console.warn('[Security] Rejecting transfer-request with invalid file size:', req.size);
    if (dc && dc.readyState === 'open') {
      dc.send(JSON.stringify({
        type: 'transfer-reject',
        transferId: req.transferId,
        reason: '檔案大小超過 10GB 限制或格式無效'
      }));
    }
    return;
  }

  const safeFilename = sanitizeFilename(req.name);

  // Set up pending consent state
  currentPendingConsent = {
    transferId: req.transferId,
    name: safeFilename,
    size: req.size,
    mime: req.mime || 'application/octet-stream',
    senderDeviceName: (req.senderDeviceName || 'Unknown Device').slice(0, 64),
    senderId,
    dc
  };

  // Populate modal UI
  if (elTransferModalFrom) elTransferModalFrom.textContent = `來自: ${escapeHtml(currentPendingConsent.senderDeviceName)}`;
  if (elTransferModalFilename) elTransferModalFilename.textContent = safeFilename;
  if (elTransferModalFilesize) elTransferModalFilesize.textContent = formatBytes(req.size);

  let remainingSeconds = 30;
  if (elTransferModalCountdown) elTransferModalCountdown.textContent = remainingSeconds;

  if (consentCountdownTimer) clearInterval(consentCountdownTimer);
  consentCountdownTimer = setInterval(() => {
    remainingSeconds--;
    if (elTransferModalCountdown) elTransferModalCountdown.textContent = remainingSeconds;
    if (remainingSeconds <= 0) {
      clearInterval(consentCountdownTimer);
      consentCountdownTimer = null;
      declineTransferConsent('30 秒超時未回應，已自動拒絕');
    }
  }, 1000);

  if (elTransferModal) elTransferModal.style.display = 'flex';
}

function acceptTransferConsent() {
  if (consentCountdownTimer) {
    clearInterval(consentCountdownTimer);
    consentCountdownTimer = null;
  }
  if (!currentPendingConsent) return;

  const { transferId, name, size, mime, dc } = currentPendingConsent;
  if (elTransferModal) elTransferModal.style.display = 'none';

  // Prepare receiving record
  currentReceiving = {
    id: transferId,
    name,
    size,
    mime,
    chunks: [],
    receivedBytes: 0,
    startTime: Date.now(),
    accepted: true
  };

  currentPendingConsent = null;

  // Send transfer-accept back to sender
  try {
    if (dc && dc.readyState === 'open') {
      dc.send(JSON.stringify({
        type: 'transfer-accept',
        transferId
      }));
    }
  } catch (err) {
    console.error('Failed to send transfer-accept:', err);
  }

  showTransferUI(`Receiving: ${name}`);
}

function declineTransferConsent(reason = '接收端使用者已拒絕') {
  if (consentCountdownTimer) {
    clearInterval(consentCountdownTimer);
    consentCountdownTimer = null;
  }
  if (!currentPendingConsent) return;

  const { transferId, dc } = currentPendingConsent;
  if (elTransferModal) elTransferModal.style.display = 'none';
  currentPendingConsent = null;

  try {
    if (dc && dc.readyState === 'open') {
      dc.send(JSON.stringify({
        type: 'transfer-reject',
        transferId,
        reason
      }));
    }
  } catch (err) {
    console.error('Failed to send transfer-reject:', err);
  }
}

async function completeReception(rec) {
  // Tuturu notification sound (Mac native app handles audio through playTuturuSound)
  if (!window.webkit || !window.webkit.messageHandlers || !window.webkit.messageHandlers.crossdropNative) {
    playSuccessSound();
  }
  const blob = new Blob(rec.chunks, { type: rec.mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);

  // If running inside Mac native host, stream directly to disk via localhost endpoint
  if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.crossdropNative) {
    try {
      const res = await fetch('/api/save-file', {
        method: 'POST',
        headers: { 'X-Filename': encodeURIComponent(rec.name) },
        body: blob
      });
      const data = await res.json();
      if (data.ok) {
        window.webkit.messageHandlers.crossdropNative.postMessage({
          type: 'file-saved-notification',
          name: data.name || rec.name,
          size: rec.size
        });
      }
    } catch (err) {
      console.error('Failed to save file via streaming endpoint, fallback to IPC:', err);
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result.split(',')[1];
        window.webkit.messageHandlers.crossdropNative.postMessage({
          type: 'file-received',
          name: rec.name,
          base64: base64
        });
      };
      reader.readAsDataURL(blob);
    }
  } else {
    // Normal browser download (e.g. Android Chrome receiving files from Mac)
    const a = document.createElement('a');
    a.href = url;
    a.download = rec.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // Add to UI list
  const row = document.createElement('div');
  row.className = 'file-row';
  row.innerHTML = `
    <div class="file-info">
      <span style="font-size: 20px;">💾</span>
      <div>
        <div class="file-name">${escapeHtml(rec.name)}</div>
        <div class="file-size">${formatBytes(rec.size)} • Just now</div>
      </div>
    </div>
    <a href="${url}" download="${escapeHtml(rec.name)}" class="btn btn-secondary" style="padding: 6px 12px; text-decoration: none;">Download</a>
  `;
  elReceivedList.prepend(row);

  hideTransferUI();
}

// File Sending Logic (with P0-3 Transfer Consent & Flow Control)
async function sendFiles(targetId, files) {
  if (!files || files.length === 0) return;

  // Validate all files size <= MAX_FILE_SIZE
  for (const f of files) {
    if (f.size > MAX_FILE_SIZE) {
      alert(`檔案「${f.name}」大小超出 10 GB 限制，無法傳輸。`);
      return;
    }
  }

  let wakeLock = null;
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen').catch(() => null);
    }

    showTransferUI(`Connecting to device (${files.length} file(s))...`);
    const dc = await ensureDataChannel(targetId);

    for (let i = 0; i < files.length; i++) {
      await sendSingleFile(dc, files[i], i, files.length);
    }
    playSuccessSound();
  } catch (err) {
    alert('Transfer failed: ' + err.message);
  } finally {
    if (wakeLock) {
      wakeLock.release().catch(() => null);
      wakeLock = null;
    }
    hideTransferUI();
  }
}

async function sendSingleFile(dc, file, fileIdx, totalFiles) {
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const transferId = generateSecureId('tx');

  showTransferUI(`等待對方確認接收 (${fileIdx + 1}/${totalFiles}): ${file.name}...`);

  // P0-3: Send transfer-request first and await recipient consent
  dc.send(JSON.stringify({
    type: 'transfer-request',
    transferId: transferId,
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
    senderDeviceName: deviceName
  }));

  // Wait for transfer-accept or transfer-reject (30-second timeout)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingTransferConsents.delete(transferId);
      reject(new Error('對方未在 30 秒內回應傳輸請求（連線逾時）'));
    }, 30000);

    pendingTransferConsents.set(transferId, {
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      }
    });
  });

  // Recipient accepted! Send header and begin streaming
  showTransferUI(`Sending (${fileIdx + 1}/${totalFiles}): ${file.name}`);

  dc.send(JSON.stringify({
    type: 'header',
    id: transferId,
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
    totalChunks,
    chunkSize: CHUNK_SIZE
  }));

  const startTime = Date.now();
  let offset = 0;

  while (offset < file.size) {
    // True backpressure: wait while buffer is high
    while (dc.bufferedAmount > BUFFER_THRESHOLD) {
      await new Promise((resolve) => {
        const onLow = () => {
          dc.removeEventListener('bufferedamountlow', onLow);
          resolve();
        };
        dc.bufferedAmountLowThreshold = Math.floor(BUFFER_THRESHOLD / 4);
        dc.addEventListener('bufferedamountlow', onLow);
        setTimeout(() => {
          dc.removeEventListener('bufferedamountlow', onLow);
          resolve();
        }, 50);
      });

      if (dc.readyState !== 'open') {
        throw new Error('DataChannel 連線意外中斷（請確保螢幕開啟並重試）');
      }
    }

    const currentChunkSize = Math.min(CHUNK_SIZE, file.size - offset);
    const slice = file.slice(offset, offset + currentChunkSize);
    const buffer = await slice.arrayBuffer();
    dc.send(buffer);

    offset += buffer.byteLength;
    updateProgress(offset, file.size, startTime);
  }

  // Send done
  dc.send(JSON.stringify({
    type: 'done',
    id: transferId
  }));

  // Wait for ACK from receiver before continuing to the next file (with 25s safety timeout for large videos)
  await new Promise((resolve) => {
    const ackTimer = setTimeout(() => {
      pendingAcks.delete(transferId);
      resolve();
    }, 25000);
    pendingAcks.set(transferId, () => {
      clearTimeout(ackTimer);
      resolve();
    });
  });

  // Pause briefly to let network socket and receiver memory settle
  await new Promise(r => setTimeout(r, 60));

  if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.crossdropNative) {
    window.webkit.messageHandlers.crossdropNative.postMessage({
      type: 'transfer-complete'
    });
  }
}

// UI Helpers
function renderPeers() {
  if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.crossdropNative) {
    window.webkit.messageHandlers.crossdropNative.postMessage({
      type: 'peers-updated',
      peers: Array.from(peers.values())
    });
  }

  elPeersContainer.innerHTML = '';

  if (peers.size === 0) {
    elPeersContainer.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; color: var(--text-sub); padding: 20px 0; font-size: 13px;">
        目前尚無其他已配對連線的裝置。<br>
        請在手機上掃描 QR Code 或輸入上方 6 位數 PIN 碼連線。
      </div>
    `;
    return;
  }

  peers.forEach((peer) => {
    const isOnline = dataChannels.has(peer.deviceId) && dataChannels.get(peer.deviceId).readyState === 'open';
    const isSelected = selectedPeerId === peer.deviceId;

    const icon = peer.deviceType === 'mac' ? '💻' : (peer.deviceType === 'android' ? '📱' : '🖥️');

    const card = document.createElement('div');
    card.className = `peer-item ${isSelected ? 'selected' : ''}`;
    card.innerHTML = `
      <div class="peer-icon">${icon}</div>
      <div class="peer-name">${escapeHtml(peer.deviceName)}</div>
      <div class="peer-status">${isOnline ? '🟢 Ready' : '⚪ Tap to connect'}</div>
    `;

    card.onclick = () => {
      selectedPeerId = peer.deviceId;
      renderPeers();
      elFileInput.click();
    };

    elPeersContainer.appendChild(card);
  });
}

function updateProgress(currentBytes, totalBytes, startTime) {
  const percent = Math.min(100, Math.round((currentBytes / totalBytes) * 100));
  elProgressBar.style.width = percent + '%';
  elTransferPercent.textContent = percent + '%';

  if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.crossdropNative) {
    window.webkit.messageHandlers.crossdropNative.postMessage({
      type: 'transfer-progress',
      percent: percent,
      name: currentSending?.name || currentReceiving?.name || 'File'
    });
  }

  const elapsedSec = (Date.now() - startTime) / 1000;
  if (elapsedSec > 0.2) {
    const bytesPerSec = currentBytes / elapsedSec;
    const speedMB = (bytesPerSec / (1024 * 1024)).toFixed(1);
    elTransferSpeed.textContent = `${speedMB} MB/s`;

    const remainingSec = Math.max(0, Math.round((totalBytes - currentBytes) / bytesPerSec));
    elTransferRemaining.textContent = `${remainingSec}s remaining`;
  }
}

function showTransferUI(title) {
  elTransferTitle.textContent = title;
  elProgressBar.style.width = '0%';
  elTransferPercent.textContent = '0%';
  elTransferSpeed.textContent = '0.0 MB/s';
  elTransferRemaining.textContent = 'Calculating...';
  elTransferCard.style.display = 'flex';
}

function hideTransferUI() {
  setTimeout(() => {
    elTransferCard.style.display = 'none';
  }, 1200);
}

function playSuccessSound() {
  try {
    const audio = new Audio('/tuturu.mp3');
    audio.play().catch(() => {
      playSynthChime();
    });
  } catch (e) {
    playSynthChime();
  }
}

function playSynthChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
    osc.frequency.setValueAtTime(880.00, ctx.currentTime + 0.12); // A5

    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + 0.45);
  } catch (e) {
    // Ignore autoplay restriction
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function setupEventListeners() {
  // Visitor PIN submission
  if (elBtnSubmitPin) {
    elBtnSubmitPin.onclick = () => {
      const pinVal = (elPinInput ? elPinInput.value.trim() : '');
      if (pinVal.length !== 6 || !/^\d{6}$/.test(pinVal)) {
        showPinError('請輸入正確的 6 位數數字 PIN 碼');
        return;
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'register',
          deviceId,
          deviceName,
          deviceType: getDeviceType(),
          pin: pinVal
        }));
      }
    };
  }

  // Host PIN / Token refresh
  if (elBtnRefreshPin) {
    elBtnRefreshPin.onclick = () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'generate-token' }));
        ws.send(JSON.stringify({ type: 'generate-pin' }));
      }
    };
  }

  // Transfer Consent Modal Actions
  if (elBtnTransferAccept) {
    elBtnTransferAccept.onclick = acceptTransferConsent;
  }
  if (elBtnTransferReject) {
    elBtnTransferReject.onclick = () => declineTransferConsent('接收端使用者拒絕接收');
  }

  // Drop zone drag & drop
  elDropZone.onclick = () => {
    if (!selectedPeerId && peers.size === 1) {
      selectedPeerId = Array.from(peers.keys())[0];
    }
    elFileInput.click();
  };

  elDropZone.ondragover = (e) => {
    e.preventDefault();
    elDropZone.classList.add('dragover');
  };

  elDropZone.ondragleave = () => {
    elDropZone.classList.remove('dragover');
  };

  elDropZone.ondrop = (e) => {
    e.preventDefault();
    elDropZone.classList.remove('dragover');

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFilesSelected(files);
    }
  };

  elFileInput.onchange = () => {
    if (elFileInput.files.length > 0) {
      handleFilesSelected(elFileInput.files);
    }
  };

  const btnQr = document.getElementById('btn-show-qr');
  const qrModal = document.getElementById('qr-modal');
  if (btnQr && qrModal) {
    btnQr.onclick = () => {
      if (qrModal.style.display === 'block') {
        qrModal.style.display = 'none';
      } else {
        qrModal.style.display = 'block';
        if (isMacHost() && ws && ws.readyState === WebSocket.OPEN) {
          if (!tokenGeneratedAt || (Date.now() - tokenGeneratedAt > 5 * 60 * 1000)) {
            ws.send(JSON.stringify({ type: 'generate-token' }));
          }
        }
        renderQrCode();
      }
    };
  }

  const btnReconnectTunnel = document.getElementById('btn-reconnect-tunnel');
  if (btnReconnectTunnel) {
    btnReconnectTunnel.onclick = () => {
      btnReconnectTunnel.disabled = true;
      btnReconnectTunnel.textContent = '連線中...';
      window.setTunnelReconnecting();
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.crossdropNative) {
        window.webkit.messageHandlers.crossdropNative.postMessage({ type: 'restart-tunnel' });
      }
      setTimeout(() => {
        btnReconnectTunnel.disabled = false;
        btnReconnectTunnel.textContent = '🔄 刷新';
      }, 5000);
    };
  }
}

function handleFilesSelected(files) {
  if (!selectedPeerId) {
    if (peers.size === 1) {
      selectedPeerId = Array.from(peers.keys())[0];
    } else if (peers.size > 1) {
      alert('請先在上方點選要接收檔案的裝置。');
      return;
    } else {
      alert('尚未連線到其他裝置！請先用手機開啟連線。');
      return;
    }
  }

  sendFiles(selectedPeerId, files);
}

// P1-4: Secure JSON Bridge for macOS native host (Eliminates string interpolation injection)
window.nativeSendFileJSON = function(payload) {
  try {
    if (!payload || !payload.targetId || !payload.base64) return;
    const binaryString = atob(payload.base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const safeName = sanitizeFilename(payload.name || 'file');
    const file = new File([bytes], safeName, { type: payload.mime || 'application/octet-stream' });
    sendFiles(payload.targetId, [file]);
  } catch (err) {
    console.error('nativeSendFileJSON error:', err);
  }
};

// Backward-compatible fallback
window.nativeSendFile = function(targetId, name, size, mime, base64) {
  window.nativeSendFileJSON({ targetId, name, size, mime, base64 });
};

// 5G URL banner & QR with Token update
function updatePublicUrlBanner() {
  const banner = document.getElementById('connection-banner');
  const urlText = document.getElementById('public-url-text');
  const btnCopy = document.getElementById('btn-copy-url');

  if (!publicTunnelUrl) {
    if (banner) banner.style.display = 'block';
    if (urlText) urlText.innerHTML = '<span style="color: var(--warning); font-size: 12px;">⏳ 正在建立 5G 加密連線...</span>';
    return;
  }

  // Attach one-time pairing token if available
  const fullUrl = currentPairingToken
    ? `${publicTunnelUrl}/?token=${currentPairingToken}`
    : publicTunnelUrl;

  if (banner && urlText) {
    banner.style.display = 'block';
    urlText.textContent = fullUrl;

    if (btnCopy) {
      btnCopy.onclick = () => {
        navigator.clipboard.writeText(fullUrl);
        btnCopy.textContent = '已複製!';
        setTimeout(() => { btnCopy.textContent = '複製'; }, 2000);
      };
    }
  }

  const qrModal = document.getElementById('qr-modal');
  if (qrModal && qrModal.style.display === 'block') {
    renderQrCode();
  }
}

function updateLocalWifiBanner() {
  if (!localWifiUrl) return;
  const localRow = document.getElementById('local-wifi-row');
  const localText = document.getElementById('local-url-text');
  const btnCopyLocal = document.getElementById('btn-copy-local');

  const fullLocalUrl = currentPairingToken
    ? `${localWifiUrl}/?token=${currentPairingToken}`
    : localWifiUrl;

  if (localRow && localText) {
    localRow.style.display = 'block';
    localText.textContent = fullLocalUrl;

    if (btnCopyLocal) {
      btnCopyLocal.onclick = () => {
        navigator.clipboard.writeText(fullLocalUrl);
        btnCopyLocal.textContent = '已複製!';
        setTimeout(() => { btnCopyLocal.textContent = '複製'; }, 2000);
      };
    }
  }
}

async function renderQrCode() {
  const qrImage = document.getElementById('qr-image');
  if (!qrImage) return;

  const targetBase = publicTunnelUrl || localWifiUrl;
  if (!targetBase) return;

  const targetUrl = currentPairingToken
    ? `${targetBase}/?token=${currentPairingToken}`
    : targetBase;

  try {
    const res = await fetch(`/api/qr?url=${encodeURIComponent(targetUrl)}`);
    const data = await res.json();
    if (data.qr) qrImage.src = data.qr;
  } catch (e) {
    console.error('Failed to load QR:', e);
  }
}

window.setTunnelReconnecting = function() {
  const urlText = document.getElementById('public-url-text');
  if (urlText) {
    urlText.innerHTML = '<span style="color: var(--warning); font-size: 12px;">⏳ 正在重新建立 5G 加密連線...</span>';
  }
};

window.setPublicUrlJSON = function(payload) {
  if (payload && payload.url) {
    publicTunnelUrl = payload.url;
    updatePublicUrlBanner();
    updateLocalWifiBanner();
  }
};

window.setPublicUrl = function(url) {
  if (!url) return;
  publicTunnelUrl = url;
  updatePublicUrlBanner();
  updateLocalWifiBanner();
};

// Start
window.addEventListener('DOMContentLoaded', init);
