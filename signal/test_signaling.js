/**
 * Test script for CrossDrop Signaling Server
 * Verifies that two mock devices (Mac & Android) can connect, register via secure Token, pair, and exchange signaling messages.
 */

const { WebSocket } = require('ws');

const SIGNAL_URL = process.env.SIGNAL_URL || 'ws://localhost:3000';

async function runTest() {
  console.log('--- Starting Signaling Server Secure Pairing Automated Test ---');

  const macWs = new WebSocket(SIGNAL_URL);
  let androidWs = null;
  let pairingToken = null;

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Test timed out after 15s')), 15000);

    macWs.on('open', () => {
      console.log('[Test] Mac connected, creating secure room...');
      macWs.send(JSON.stringify({
        type: 'create-room',
        deviceId: 'mac-unit-test-01',
        deviceName: "Patric's Mac (Test)",
        deviceType: 'mac'
      }));
    });

    macWs.on('message', (raw) => {
      const msg = JSON.parse(raw);

      if (msg.type === 'room-created') {
        console.log('[Test] Mac room created successfully:', msg.roomId);
        // Request one-time pairing token for Android
        macWs.send(JSON.stringify({ type: 'generate-token' }));
      }

      if (msg.type === 'token-generated') {
        pairingToken = msg.token;
        console.log('[Test] Pairing token generated:', pairingToken);

        // Now connect Android using this one-time pairing token
        androidWs = new WebSocket(SIGNAL_URL);

        androidWs.on('open', () => {
          console.log('[Test] Android connected, registering with pairing token...');
          androidWs.send(JSON.stringify({
            type: 'register',
            deviceId: 'android-unit-test-01',
            deviceName: "Patric's Phone (Test)",
            deviceType: 'android',
            token: pairingToken
          }));
        });

        androidWs.on('message', (androidRaw) => {
          const aMsg = JSON.parse(androidRaw);
          if (aMsg.type === 'registered') {
            console.log('[Test] Android authorized and registered successfully!');
          }
          if (aMsg.type === 'signal') {
            if (aMsg.fromId === 'mac-unit-test-01' && aMsg.data.type === 'offer') {
              console.log('[Test] SUCCESS: Android received WebRTC Offer relayed from Mac!');
              clearTimeout(timeout);
              resolve();
            }
          }
        });

        androidWs.on('error', reject);
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

    macWs.on('error', reject);
  });

  macWs.close();
  if (androidWs) androidWs.close();

  console.log('--- Test Passed: Secure Signaling, Token Pairing, and Signal Relay are working perfectly! ---');
}

runTest().catch((err) => {
  console.error('[Test FAILED]:', err);
  process.exit(1);
});
