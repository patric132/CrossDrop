package com.crossdrop

import android.content.Context
import org.json.JSONObject
import org.webrtc.*
import java.nio.ByteBuffer

class WebRTCManager(
    private val context: Context,
    private val signalingClient: SignalingClient,
    private val targetDeviceId: String,
    private val isInitiator: Boolean,
    private val listener: Listener
) {
    interface Listener {
        fun onChannelReady()
        fun onProgress(bytesTransferred: Long, totalBytes: Long)
        fun onFileReceived(fileName: String, data: ByteArray)
        fun onError(error: String)
    }

    private var peerConnectionFactory: PeerConnectionFactory? = null
    private var peerConnection: PeerConnection? = null
    private var dataChannel: DataChannel? = null

    // Chunking params
    val CHUNK_SIZE = 64 * 1024 // 64 KB
    val BUFFER_THRESHOLD = 1024 * 1024L // 1 MB backpressure

    init {
        initPeerConnectionFactory()
        createPeerConnection()
        if (isInitiator) {
            setupDataChannel()
            createOffer()
        }
    }

    private fun initPeerConnectionFactory() {
        val options = PeerConnectionFactory.InitializationOptions.builder(context)
            .setEnableInternalTracer(false)
            .createInitializationOptions()
        PeerConnectionFactory.initialize(options)

        peerConnectionFactory = PeerConnectionFactory.builder()
            .setOptions(PeerConnectionFactory.Options())
            .createPeerConnectionFactory()
    }

    private fun createPeerConnection() {
        val iceServers = listOf(
            PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
            PeerConnection.IceServer.builder("stun:stun1.l.google.com:19302").createIceServer(),
            PeerConnection.IceServer.builder("stun:stun2.l.google.com:19302").createIceServer()
        )

        val rtcConfig = PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }

        peerConnection = peerConnectionFactory?.createPeerConnection(rtcConfig, object : PeerConnection.Observer {
            override fun onIceCandidate(candidate: IceCandidate) {
                val candJson = JSONObject().apply {
                    put("candidate", candidate.sdp)
                    put("sdpMid", candidate.sdpMid)
                    put("sdpMLineIndex", candidate.sdpMLineIndex)
                }
                val signal = JSONObject().apply {
                    put("candidate", candJson)
                }
                signalingClient.sendSignal(targetDeviceId, signal)
            }

            override fun onDataChannel(dc: DataChannel) {
                dataChannel = dc
                attachDataChannelObserver(dc)
            }

            override fun onIceConnectionChange(newState: PeerConnection.IceConnectionState) {
                if (newState == PeerConnection.IceConnectionState.FAILED) {
                    listener.onError("P2P Connection failed")
                }
            }

            override fun onSignalingChange(state: PeerConnection.SignalingState) {}
            override fun onIceConnectionReceivingChange(receiving: Boolean) {}
            override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {}
            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
            override fun onAddStream(stream: MediaStream) {}
            override fun onRemoveStream(stream: MediaStream) {}
            override fun onRenegotiationNeeded() {}
            override fun onAddTrack(receiver: RtpReceiver, mediaStreams: Array<out MediaStream>) {}
        })
    }

    private fun setupDataChannel() {
        val init = DataChannel.Init().apply {
            ordered = true
        }
        dataChannel = peerConnection?.createDataChannel("crossdrop-files", init)
        dataChannel?.let { attachDataChannelObserver(it) }
    }

    private var incomingHeader: JSONObject? = null
    private var incomingBytes = mutableListOf<ByteArray>()
    private var receivedBytesCount = 0L

    private fun attachDataChannelObserver(dc: DataChannel) {
        dc.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(previousAmount: Long) {}

            override fun onStateChange() {
                if (dc.state() == DataChannel.ChannelState.OPEN) {
                    listener.onChannelReady()
                }
            }

            override fun onMessage(buffer: DataChannel.Buffer) {
                if (!buffer.binary) {
                    val bytes = ByteArray(buffer.data.remaining())
                    buffer.data.get(bytes)
                    val text = String(bytes, Charsets.UTF_8)
                    val json = JSONObject(text)

                    when (json.optString("type")) {
                        "header" -> {
                            incomingHeader = json
                            incomingBytes.clear()
                            receivedBytesCount = 0L
                        }
                        "done" -> {
                            val header = incomingHeader
                            if (header != null) {
                                val fileName = header.getString("name")
                                val totalSize = header.getLong("size")
                                val completeBytes = ByteArray(totalSize.toInt())
                                var offset = 0
                                for (chunk in incomingBytes) {
                                    System.arraycopy(chunk, 0, completeBytes, offset, chunk.size)
                                    offset += chunk.size
                                }
                                listener.onFileReceived(fileName, completeBytes)
                                incomingHeader = null
                                incomingBytes.clear()
                            }
                        }
                    }
                } else {
                    val bytes = ByteArray(buffer.data.remaining())
                    buffer.data.get(bytes)
                    incomingBytes.add(bytes)
                    receivedBytesCount += bytes.size

                    val total = incomingHeader?.optLong("size", 0L) ?: 0L
                    if (total > 0) {
                        listener.onProgress(receivedBytesCount, total)
                    }
                }
            }
        })
    }

    fun handleRemoteSignal(data: JSONObject) {
        if (data.has("sdp")) {
            val sdpType = if (data.getString("type") == "offer") SessionDescription.Type.OFFER else SessionDescription.Type.ANSWER
            val sdp = SessionDescription(sdpType, data.getString("sdp"))
            peerConnection?.setRemoteDescription(object : SimpleSdpObserver() {
                override fun onSetSuccess() {
                    if (sdpType == SessionDescription.Type.OFFER) {
                        createAnswer()
                    }
                }
            }, sdp)
        } else if (data.has("candidate")) {
            val candJson = data.getJSONObject("candidate")
            val candidate = IceCandidate(
                candJson.getString("sdpMid"),
                candJson.getInt("sdpMLineIndex"),
                candJson.getString("candidate")
            )
            peerConnection?.addIceCandidate(candidate)
        }
    }

    private fun createOffer() {
        val sdpConstraints = MediaConstraints()
        peerConnection?.createOffer(object : SimpleSdpObserver() {
            override fun onCreateSuccess(desc: SessionDescription) {
                peerConnection?.setLocalDescription(object : SimpleSdpObserver() {
                    override fun onSetSuccess() {
                        val signal = JSONObject().apply {
                            put("sdp", desc.description)
                            put("type", "offer")
                        }
                        signalingClient.sendSignal(targetDeviceId, signal)
                    }
                }, desc)
            }
        }, sdpConstraints)
    }

    private fun createAnswer() {
        val sdpConstraints = MediaConstraints()
        peerConnection?.createAnswer(object : SimpleSdpObserver() {
            override fun onCreateSuccess(desc: SessionDescription) {
                peerConnection?.setLocalDescription(object : SimpleSdpObserver() {
                    override fun onSetSuccess() {
                        val signal = JSONObject().apply {
                            put("sdp", desc.description)
                            put("type", "answer")
                        }
                        signalingClient.sendSignal(targetDeviceId, signal)
                    }
                }, desc)
            }
        }, sdpConstraints)
    }

    fun sendHeader(transferId: String, name: String, size: Long, mime: String) {
        val totalChunks = Math.ceil(size.toDouble() / CHUNK_SIZE).toInt()
        val header = JSONObject().apply {
            put("type", "header")
            put("id", transferId)
            put("name", name)
            put("size", size)
            put("mime", mime)
            put("totalChunks", totalChunks)
            put("chunkSize", CHUNK_SIZE)
        }
        val bytes = header.toString().toByteArray(Charsets.UTF_8)
        dataChannel?.send(DataChannel.Buffer(ByteBuffer.wrap(bytes), false))
    }

    fun sendChunk(bytes: ByteArray) {
        dataChannel?.send(DataChannel.Buffer(ByteBuffer.wrap(bytes), true))
    }

    fun sendDone(transferId: String) {
        val done = JSONObject().apply {
            put("type", "done")
            put("id", transferId)
        }
        val bytes = done.toString().toByteArray(Charsets.UTF_8)
        dataChannel?.send(DataChannel.Buffer(ByteBuffer.wrap(bytes), false))
    }

    fun getBufferedAmount(): Long = dataChannel?.bufferedAmount() ?: 0L

    fun close() {
        dataChannel?.close()
        peerConnection?.close()
        peerConnectionFactory?.dispose()
    }

    open class SimpleSdpObserver : SdpObserver {
        override fun onCreateSuccess(desc: SessionDescription) {}
        override fun onSetSuccess() {}
        override fun onCreateFailure(s: String) {}
        override fun onSetFailure(s: String) {}
    }
}
