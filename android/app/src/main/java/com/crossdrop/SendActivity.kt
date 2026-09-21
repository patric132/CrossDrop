package com.crossdrop

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.widget.Button
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.InputStream
import java.util.*

class SendActivity : AppCompatActivity() {

    private lateinit var tvFileName: TextView
    private lateinit var progressBar: ProgressBar
    private lateinit var tvPercent: TextView
    private lateinit var tvSpeed: TextView
    private lateinit var btnCancel: Button

    private var signalingClient: SignalingClient? = null
    private var webRTCManager: WebRTCManager? = null

    private val filesToSend = mutableListOf<Uri>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_send)

        tvFileName = findViewById(R.id.tvSendingFileName)
        progressBar = findViewById(R.id.progressBar)
        tvPercent = findViewById(R.id.tvProgressPercent)
        tvSpeed = findViewById(R.id.tvSpeed)
        btnCancel = findViewById(R.id.btnCancel)

        btnCancel.setOnClickListener {
            cleanup()
            finish()
        }

        handleShareIntent(intent)
    }

    private fun handleShareIntent(intent: Intent) {
        val action = intent.action
        val type = intent.type

        if (Intent.ACTION_SEND == action && type != null) {
            val uri = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
            if (uri != null) filesToSend.add(uri)
        } else if (Intent.ACTION_SEND_MULTIPLE == action && type != null) {
            val uris = intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
            if (uris != null) filesToSend.addAll(uris)
        }

        if (filesToSend.isEmpty()) {
            Toast.makeText(this, "No files found to send", Toast.LENGTH_SHORT).show()
            finish()
            return
        }

        tvFileName.text = "Selected ${filesToSend.size} file(s)"
        startTransferProcess()
    }

    private fun startTransferProcess() {
        val prefs = getSharedPreferences("crossdrop_prefs", MODE_PRIVATE)
        val pairKey = prefs.getString("pair_key", "") ?: ""
        val serverUrl = prefs.getString("server_url", "ws://10.0.0.1:3000") ?: "ws://10.0.0.1:3000"

        val deviceId = "android-" + UUID.randomUUID().toString().substring(0, 8)
        val deviceName = "Android Phone"

        tvSpeed.text = "Connecting to signaling server..."

        signalingClient = SignalingClient(
            serverUrl = serverUrl,
            deviceId = deviceId,
            deviceName = deviceName,
            pairKey = pairKey,
            listener = object : SignalingClient.Listener {
                override fun onRegistered(peers: List<SignalingClient.PeerInfo>) {
                    val macPeer = peers.find { it.deviceType == "mac" } ?: peers.firstOrNull()
                    if (macPeer != null) {
                        runOnUiThread {
                            tvSpeed.text = "Found ${macPeer.deviceName}! Establishing direct P2P..."
                            initWebRTC(macPeer.deviceId)
                        }
                    } else {
                        runOnUiThread {
                            tvSpeed.text = "Waiting for Mac to come online..."
                        }
                    }
                }

                override fun onPeerJoined(peer: SignalingClient.PeerInfo) {
                    runOnUiThread {
                        tvSpeed.text = "Found ${peer.deviceName}! Establishing direct P2P..."
                        initWebRTC(peer.deviceId)
                    }
                }

                override fun onPeerLeft(deviceId: String) {}

                override fun onSignalReceived(fromId: String, data: JSONObject) {
                    webRTCManager?.handleRemoteSignal(data)
                }

                override fun onError(message: String) {
                    runOnUiThread {
                        tvSpeed.text = "Error: $message"
                    }
                }
            }
        )

        signalingClient?.connect()
    }

    private fun initWebRTC(targetMacId: String) {
        if (webRTCManager != null) return

        webRTCManager = WebRTCManager(
            context = this,
            signalingClient = signalingClient!!,
            targetDeviceId = targetMacId,
            isInitiator = true,
            listener = object : WebRTCManager.Listener {
                override fun onChannelReady() {
                    runOnUiThread {
                        tvSpeed.text = "P2P Connected! Sending files..."
                        sendAllFiles()
                    }
                }

                override fun onProgress(bytesTransferred: Long, totalBytes: Long) {
                    runOnUiThread {
                        val pct = ((bytesTransferred.toDouble() / totalBytes) * 100).toInt()
                        progressBar.progress = pct
                        tvPercent.text = "$pct%"
                    }
                }

                override fun onFileReceived(fileName: String, data: ByteArray) {}

                override fun onError(error: String) {
                    runOnUiThread {
                        Toast.makeText(this@SendActivity, error, Toast.LENGTH_SHORT).show()
                    }
                }
            }
        )
    }

    private fun sendAllFiles() {
        lifecycleScope.launch(Dispatchers.IO) {
            val rtc = webRTCManager ?: return@launch

            for (uri in filesToSend) {
                val (name, size) = getFileInfo(uri)
                val mime = contentResolver.getType(uri) ?: "application/octet-stream"
                val txId = "tx-" + System.currentTimeMillis()

                withContext(Dispatchers.Main) {
                    tvFileName.text = name
                }

                // Send Header
                rtc.sendHeader(txId, name, size, mime)

                // Stream chunks
                var inputStream: InputStream? = null
                try {
                    inputStream = contentResolver.openInputStream(uri)
                    val buffer = ByteArray(rtc.CHUNK_SIZE)
                    var bytesRead: Int
                    var totalSent = 0L
                    val startTime = System.currentTimeMillis()

                    while (inputStream?.read(buffer).also { bytesRead = it ?: -1 } != -1) {
                        // Flow control: backpressure
                        while (rtc.getBufferedAmount() > rtc.BUFFER_THRESHOLD) {
                            delay(10)
                        }

                        val chunk = if (bytesRead == rtc.CHUNK_SIZE) buffer else buffer.copyOf(bytesRead)
                        rtc.sendChunk(chunk)
                        totalSent += bytesRead

                        val elapsed = (System.currentTimeMillis() - startTime) / 1000.0
                        if (elapsed > 0.3) {
                            val speedMB = String.format("%.1f", (totalSent / (1024 * 1024.0)) / elapsed)
                            withContext(Dispatchers.Main) {
                                tvSpeed.text = "$speedMB MB/s (Direct P2P)"
                            }
                        }

                        val pct = ((totalSent.toDouble() / size) * 100).toInt()
                        withContext(Dispatchers.Main) {
                            progressBar.progress = pct
                            tvPercent.text = "$pct%"
                        }
                    }

                    // Send Done
                    rtc.sendDone(txId)
                } catch (e: Exception) {
                    e.printStackTrace()
                } finally {
                    inputStream?.close()
                }
            }

            withContext(Dispatchers.Main) {
                Toast.makeText(this@SendActivity, "All files sent to Mac!", Toast.LENGTH_LONG).show()
                delay(800)
                cleanup()
                finish()
            }
        }
    }

    private fun getFileInfo(uri: Uri): Pair<String, Long> {
        var name = "file"
        var size = 0L
        contentResolver.query(uri, null, null, null, null)?.use { cursor ->
            val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
            if (cursor.moveToFirst()) {
                if (nameIndex != -1) name = cursor.getString(nameIndex)
                if (sizeIndex != -1) size = cursor.getLong(sizeIndex)
            }
        }
        return Pair(name, size)
    }

    private fun cleanup() {
        webRTCManager?.close()
        signalingClient?.disconnect()
    }

    override fun onDestroy() {
        super.onDestroy()
        cleanup()
    }
}
