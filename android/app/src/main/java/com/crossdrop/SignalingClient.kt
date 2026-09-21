package com.crossdrop

import okhttp3.*
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class SignalingClient(
    private val serverUrl: String,
    private val deviceId: String,
    private val deviceName: String,
    private val pairKey: String,
    private val listener: Listener
) {
    interface Listener {
        fun onRegistered(peers: List<PeerInfo>)
        fun onPeerJoined(peer: PeerInfo)
        fun onPeerLeft(deviceId: String)
        fun onSignalReceived(fromId: String, data: JSONObject)
        fun onError(message: String)
    }

    data class PeerInfo(val deviceId: String, val deviceName: String, val deviceType: String)

    private val client = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(25, TimeUnit.SECONDS)
        .build()

    private var webSocket: WebSocket? = null

    fun connect() {
        val request = Request.Builder().url(serverUrl).build()
        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                // Register device
                val regMsg = JSONObject().apply {
                    put("type", "register")
                    put("deviceId", deviceId)
                    put("deviceName", deviceName)
                    put("deviceType", "android")
                    if (pairKey.isNotBlank()) {
                        if (pairKey.length == 6 && pairKey.all { it.isDigit() }) {
                            put("pin", pairKey.trim())
                        } else {
                            put("token", pairKey.trim())
                        }
                    }
                }
                webSocket.send(regMsg.toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    val msg = JSONObject(text)
                    when (msg.optString("type")) {
                        "registered" -> {
                            val peersList = mutableListOf<PeerInfo>()
                            val peersArray = msg.optJSONArray("peers")
                            if (peersArray != null) {
                                for (i in 0 until peersArray.length()) {
                                    val p = peersArray.getJSONObject(i)
                                    peersList.add(PeerInfo(
                                        p.getString("deviceId"),
                                        p.getString("deviceName"),
                                        p.optString("deviceType", "unknown")
                                    ))
                                }
                            }
                            listener.onRegistered(peersList)
                        }
                        "peer-joined" -> {
                            val p = msg.getJSONObject("peer")
                            listener.onPeerJoined(PeerInfo(
                                p.getString("deviceId"),
                                p.getString("deviceName"),
                                p.optString("deviceType", "unknown")
                            ))
                        }
                        "peer-left" -> {
                            listener.onPeerLeft(msg.getString("deviceId"))
                        }
                        "signal" -> {
                            val fromId = msg.getString("fromId")
                            val data = msg.getJSONObject("data")
                            listener.onSignalReceived(fromId, data)
                        }
                    }
                } catch (e: Exception) {
                    e.printStackTrace()
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                listener.onError(t.localizedMessage ?: "WebSocket connection failed")
            }
        })
    }

    fun sendSignal(targetId: String, data: JSONObject) {
        val msg = JSONObject().apply {
            put("type", "signal")
            put("targetId", targetId)
            put("data", data)
        }
        webSocket?.send(msg.toString())
    }

    fun disconnect() {
        webSocket?.close(1000, "Normal Closure")
        webSocket = null
    }
}
