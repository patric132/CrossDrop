/**
 * Test script for CrossDrop Signaling Server
 * Verifies that two mock devices (Mac & Android) can connect, register, pair, and exchange signaling messages.
 */

const { WebSocket } = require('ws');

const SIGNAL_URL = process.env.SIGNAL_URL || 'ws://localhost:3000';

async function runTest() {
  console.log('--- Starting Signaling Server Automated Test ---');

  const pairKey = 'test-room-' + Date.now();

  const macWs = new WebSocket(SIGNAL_URL);
  const androidWs = new WebSocket(SIGNAL_URL);

  let macReady = false;
  let androidReady = false;
  let signalReceived = false;

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Test timed out after 10s')), 10000);

    macWs.on('open', () => {
      console.log('[Test] Mac connected to signaling server');
      macWs.send(JSON.stringify({
        type: 'register',
        deviceId: 'mac-unit-test-01',
        deviceName: "Patric's Mac (Test)",
        deviceType: 'mac',
        pairKey: pairKey
      }));
    });

    androidWs.on('open', () => {
      console.log('[Test] Android connected to signaling server');
      androidWs.send(JSON.stringify({
        type: 'register',
        deviceId: 'android-unit-test-01',
        deviceName: "Patric's Phone (Test)",
        deviceType: 'android',
        pairKey: pairKey
      }));
    });

    macWs.on('message', (raw) => {
      const msg = JSON.parse(raw);
      // console.log('[Test] Mac received:', msg.type);

      if (msg.type === 'registered') {
        macReady = true;
      }

      if (msg.type === 'peer-joined' && msg.peer.deviceId === 'android-unit-test-01') {
        console.log('[Test] SUCCESS: Mac discovered Android peer join');
        // Mac sends a mock WebRTC Offer signal to Android
        macWs.send(JSON.stringify({
          type: 'signal',
          targetId: 'android-unit-test-01',
          data: { sdp: 'v=0\r\no=mock-sdp-offer...', type: 'offer' }
        }));
      }
    });

    androidWs.on('message', (raw) => {
      const msg = JSON.parse(raw);
      // console.log('[Test] Android received:', msg.type);

      if (msg.type === 'registered') {
        androidReady = true;
      }

      if (msg.type === 'signal') {
        if (msg.fromId === 'mac-unit-test-01' && msg.data.type === 'offer') {
          console.log('[Test] SUCCESS: Android received WebRTC Offer relayed from Mac!');
          signalReceived = true;
          clearTimeout(timeout);
          resolve();
        }
      }
    });

    macWs.on('error', reject);
    androidWs.on('error', reject);
  });

  macWs.close();
  androidWs.close();

  console.log('--- Test Passed: Signaling, Pairing, and Relay are working perfectly! ---');
  process.exit(0);
}

runTest().catch((err) => {
  console.error('[Test FAILED]:', err);
  process.exit(1);
});
