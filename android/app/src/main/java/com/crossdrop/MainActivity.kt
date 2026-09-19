package com.crossdrop

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {

    private lateinit var etPairKey: EditText
    private lateinit var etServerUrl: EditText
    private lateinit var btnSavePairKey: Button
    private lateinit var btnStartReceiver: Button
    private lateinit var tvStatus: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        etPairKey = findViewById(R.id.etPairKey)
        etServerUrl = findViewById(R.id.etServerUrl)
        btnSavePairKey = findViewById(R.id.btnSavePairKey)
        btnStartReceiver = findViewById(R.id.btnStartReceiver)
        tvStatus = findViewById(R.id.tvStatus)

        val prefs = getSharedPreferences("crossdrop_prefs", MODE_PRIVATE)
        etPairKey.setText(prefs.getString("pair_key", "my-personal-drop"))
        etServerUrl.setText(prefs.getString("server_url", "ws://10.0.0.1:3000"))

        btnSavePairKey.setOnClickListener {
            val key = etPairKey.text.toString().trim()
            val url = etServerUrl.text.toString().trim()
            if (key.isNotEmpty() && url.isNotEmpty()) {
                prefs.edit()
                    .putString("pair_key", key)
                    .putString("server_url", url)
                    .apply()
                Toast.makeText(this, "Settings saved!", Toast.LENGTH_SHORT).show()
            }
        }

        btnStartReceiver.setOnClickListener {
            val serviceIntent = Intent(this, ReceiveService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(serviceIntent)
            } else {
                startService(serviceIntent)
            }
            Toast.makeText(this, "CrossDrop receiver started in background", Toast.LENGTH_SHORT).show()
        }
    }
}
