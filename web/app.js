/**
 * CrossDrop WebRTC P2P Engine & UI Controller
 */

// Configuration
const CHUNK_SIZE = 64 * 1024; // 64 KB per chunk (standard optimal WebRTC MTU)
const BUFFER_THRESHOLD = 1024 * 1024; // 1 MB backpressure threshold (prevents Chrome 16MB buffer overflow)
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ]
};

// State
let ws = null;
let deviceId = localStorage.getItem('crossdrop_device_id') || ('dev-' + Math.random().toString(36).substring(2, 9));
localStorage.setItem('crossdrop_device_id', deviceId);

let deviceName = localStorage.getItem('crossdrop_device_name') || detectDeviceName();
let pairKey = localStorage.getItem('crossdrop_pair_key') || 'my-personal-drop';

let peers = new Map(); // targetId -> { deviceId, deviceName, deviceType }
let selectedPeerId = null;
let peerConnections = new Map(); // targetId -> RTCPeerConnection
let dataChannels = new Map(); // targetId -> RTCDataChannel
const pendingAcks = new Map(); // transferId -> resolveFunction

// Active file transfers
let currentSending = null;
let currentReceiving = null;

// DOM Elements
const elStatusDot = document.getElementById('status-dot');
const elStatusText = document.getElementById('status-text');
const elMyDeviceName = document.getElementById('my-device-name');
const elPairKeyInput = document.getElementById('pair-key-input');
const elBtnSavePair = document.getElementById('btn-save-pair');
const elBtnGenPin = document.getElementById('btn-gen-pin');
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

// Initialize
function init() {
  elMyDeviceName.textContent = deviceName;
  elPairKeyInput.value = pairKey;

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
    elStatusText.textContent = 'Connected';
    elStatusDot.className = 'status-dot connected';

    ws.send(JSON.stringify({
      type: 'register',
      deviceId,
      deviceName,
      deviceType: getDeviceType(),
      pairKey
    }));
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
    case 'registered': {
      peers.clear();
      if (msg.peers) {
        msg.peers.forEach(p => peers.set(p.deviceId, p));
      }
      renderPeers();
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

    case 'pin-generated': {
      alert(`Pairing Code: ${msg.code}\nValid for 10 minutes.`);
      break;
    }

    case 'signal': {
      const { fromId, data } = msg;
      await handlePeerSignal(fromId, data);
      break;
    }
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

    // Process queued candidates that arrived before remote description
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

  // Ensure WebSocket is open before signaling
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
    handleIncomingData(event.data, targetId);
  };
}

// File Reception Logic
function handleIncomingData(data, senderId) {
  if (typeof data === 'string') {
    const msg = JSON.parse(data);

    if (msg.type === 'file-ack') {
      const resolveAck = pendingAcks.get(msg.id);
      if (resolveAck) {
        pendingAcks.delete(msg.id);
        resolveAck();
      }
      return;
    }

    if (msg.type === 'header') {
      // Start receiving a new file
      currentReceiving = {
        id: msg.id,
        name: msg.name,
        size: msg.size,
        mime: msg.mime,
        totalChunks: msg.totalChunks,
        chunks: [],
        receivedBytes: 0,
        startTime: Date.now()
      };

      showTransferUI(`Receiving: ${msg.name}`);
    } else if (msg.type === 'done') {
      if (currentReceiving && currentReceiving.id === msg.id) {
        const finishedRec = currentReceiving;
        currentReceiving = null;
        completeReception(finishedRec).then(() => {
          // Send ACK back to sender only after file has been successfully written to disk!
          try {
            const senderDc = dataChannels.get(senderId);
            if (senderDc && senderDc.readyState === 'open') {
              senderDc.send(JSON.stringify({ type: 'file-ack', id: msg.id }));
            }
          } catch (err) {
            console.warn('Failed to send file-ack:', err);
          }
        });
      }
    }
  } else if (data instanceof ArrayBuffer) {
    if (!currentReceiving) return;

    currentReceiving.chunks.push(data);
    currentReceiving.receivedBytes += data.byteLength;

    updateProgress(currentReceiving.receivedBytes, currentReceiving.size, currentReceiving.startTime);
  }
}

async function completeReception(rec) {
  playSuccessSound();
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
      // Fallback: Read as data URL if local endpoint fails
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

// File Sending Logic
async function sendFiles(targetId, files) {
  if (!files || files.length === 0) return;

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
  const transferId = 'tx-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6);

  showTransferUI(`Sending (${fileIdx + 1}/${totalFiles}): ${file.name}`);

  // Send header
  dc.send(JSON.stringify({
    type: 'header',
    id: transferId,
    name: file.name,
    size: file.size,
    mime: file.type,
    totalChunks,
    chunkSize: CHUNK_SIZE
  }));

  const startTime = Date.now();
  let offset = 0;

  while (offset < file.size) {
    // True backpressure: wait while buffer is high, never overflow Chrome's 16MB limit
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
      resolve(); // Proceed anyway after 25s so single dropped packet doesn't stall batch
    }, 25000);
    pendingAcks.set(transferId, () => {
      clearTimeout(ackTimer);
      resolve();
    });
  });

  // Brief 60ms pause to let network socket and receiver memory settle
  await new Promise(r => setTimeout(r, 60));

  if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.crossdropNative) {
    window.webkit.messageHandlers.crossdropNative.postMessage({
      type: 'transfer-complete'
    });
  }
}

// UI Helpers
function renderPeers() {
  // Notify native host if available
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
        No other devices detected with Pair Key "<b>${escapeHtml(pairKey)}</b>"<br>
        Open CrossDrop on your other device with the same Pair Key.
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
      // Prompt file pick
      elFileInput.click();
    };

    elPeersContainer.appendChild(card);
  });
}

function updateProgress(currentBytes, totalBytes, startTime) {
  const percent = Math.min(100, Math.round((currentBytes / totalBytes) * 100));
  elProgressBar.style.width = percent + '%';
  elTransferPercent.textContent = percent + '%';

  // Notify native host
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
    // Ignore audio autoplay restrictions
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function setupEventListeners() {
  // Pair key save
  elBtnSavePair.onclick = () => {
    const val = elPairKeyInput.value.trim();
    if (val) {
      pairKey = val;
      localStorage.setItem('crossdrop_pair_key', pairKey);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'register',
          deviceId,
          deviceName,
          deviceType: getDeviceType(),
          pairKey
        }));
      }
      alert('Pair Key updated!');
    }
  };

  // Generate PIN
  elBtnGenPin.onclick = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'generate-pin' }));
    }
  };

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
}

function handleFilesSelected(files) {
  if (!selectedPeerId) {
    if (peers.size === 1) {
      selectedPeerId = Array.from(peers.keys())[0];
    } else if (peers.size > 1) {
      alert('Please select a device above to send files to.');
      return;
    } else {
      alert('No other device found! Please open CrossDrop on your other device first.');
      return;
    }
  }

  sendFiles(selectedPeerId, files);
}

// Bridge for macOS native host
window.nativeSendFile = function(targetId, name, size, mime, base64) {
  try {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const file = new File([bytes], name, { type: mime || 'application/octet-stream' });
    sendFiles(targetId, [file]);
  } catch (err) {
    console.error('nativeSendFile error:', err);
  }
};

// Display 5G URL banner & QR
window.setPublicUrl = function(url) {
  if (!url) return;
  const banner = document.getElementById('connection-banner');
  const urlText = document.getElementById('public-url-text');
  const btnCopy = document.getElementById('btn-copy-url');
  const btnQr = document.getElementById('btn-show-qr');
  const qrModal = document.getElementById('qr-modal');
  const qrImage = document.getElementById('qr-image');

  if (banner && urlText) {
    banner.style.display = 'block';
    urlText.textContent = url;

    btnCopy.onclick = () => {
      navigator.clipboard.writeText(url);
      btnCopy.textContent = '已複製!';
      setTimeout(() => { btnCopy.textContent = '複製'; }, 2000);
    };

    btnQr.onclick = async () => {
      if (qrModal.style.display === 'block') {
        qrModal.style.display = 'none';
      } else {
        qrModal.style.display = 'block';
        if (!qrImage.src || qrImage.src === '') {
          try {
            const res = await fetch(`/api/qr?url=${encodeURIComponent(url)}`);
            const data = await res.json();
            if (data.qr) qrImage.src = data.qr;
          } catch (e) {
            console.error('Failed to load QR:', e);
          }
        }
      }
    };
  }
};

// Start
window.addEventListener('DOMContentLoaded', init);
