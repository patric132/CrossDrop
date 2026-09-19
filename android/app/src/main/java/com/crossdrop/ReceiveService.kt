package com.crossdrop

import android.app.*
import android.content.Context
import android.content.Intent
import android.media.MediaScannerConnection
import android.os.Build
import android.os.Environment
import android.os.IBinder
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.*

class ReceiveService : Service() {

    private val CHANNEL_ID = "crossdrop_receiver_channel"
    private val NOTIFICATION_ID = 1001

    private var signalingClient: SignalingClient? = null
    private var webRTCManager: WebRTCManager? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, createNotification("CrossDrop is waiting for files..."))
        startSignaling()
    }

    private fun startSignaling() {
        val prefs = getSharedPreferences("crossdrop_prefs", Context.MODE_PRIVATE)
        val pairKey = prefs.getString("pair_key", "my-personal-drop") ?: "my-personal-drop"
        val serverUrl = prefs.getString("server_url", "ws://10.0.0.1:3000") ?: "ws://10.0.0.1:3000"

        val deviceId = "android-receiver-" + UUID.randomUUID().toString().substring(0, 8)
        val deviceName = "Android Phone"

        signalingClient = SignalingClient(
            serverUrl = serverUrl,
            deviceId = deviceId,
            deviceName = deviceName,
            pairKey = pairKey,
            listener = object : SignalingClient.Listener {
                override fun onRegistered(peers: List<SignalingClient.PeerInfo>) {}
                override fun onPeerJoined(peer: SignalingClient.PeerInfo) {}
                override fun onPeerLeft(deviceId: String) {}

                override fun onSignalReceived(fromId: String, data: JSONObject) {
                    if (webRTCManager == null) {
                        initWebRTC(fromId)
                    }
                    webRTCManager?.handleRemoteSignal(data)
                }

                override fun onError(message: String) {}
            }
        )
        signalingClient?.connect()
    }

    private fun initWebRTC(targetPeerId: String) {
        webRTCManager = WebRTCManager(
            context = this,
            signalingClient = signalingClient!!,
            targetDeviceId = targetPeerId,
            isInitiator = false,
            listener = object : WebRTCManager.Listener {
                override fun onChannelReady() {}

                override fun onProgress(bytesTransferred: Long, totalBytes: Long) {
                    val pct = ((bytesTransferred.toDouble() / totalBytes) * 100).toInt()
                    updateNotification("Receiving file... $pct%")
                }

                override fun onFileReceived(fileName: String, data: ByteArray) {
                    saveFileToDownloads(fileName, data)
                }

                override fun onError(error: String) {}
            }
        )
    }

    private fun saveFileToDownloads(fileName: String, data: ByteArray) {
        try {
            val downloadDir = File(
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                "CrossDrop"
            )
            if (!downloadDir.exists()) downloadDir.mkdirs()

            var targetFile = File(downloadDir, fileName)
            var counter = 1
            val nameWithoutExt = targetFile.nameWithoutExtension
            val ext = targetFile.extension

            while (targetFile.exists()) {
                targetFile = File(downloadDir, "${nameWithoutExt}_$counter.$ext")
                counter++
            }

            FileOutputStream(targetFile).use { it.write(data) }

            // Scan media to show up in Gallery
            MediaScannerConnection.scanFile(
                applicationContext,
                arrayOf(targetFile.absolutePath),
                null,
                null
            )

            updateNotification("Received $fileName! Saved to Downloads")
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "CrossDrop Background Receiver",
                NotificationManager.IMPORTANCE_LOW
            )
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }

    private fun createNotification(text: String): Notification {
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("⚡ CrossDrop")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun updateNotification(text: String) {
        val notification = createNotification(text)
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, notification)
    }

    override fun onDestroy() {
        super.onDestroy()
        webRTCManager?.close()
        signalingClient?.disconnect()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
