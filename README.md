# ⚡ CrossDrop

> **Android 與 macOS 之間真正自由的高速直連傳檔神器（AirDrop 完美跨界替代方案）**  
> 突破 Apple 生態限制：**免同 Wi-Fi**、**免開手機熱點**、**端對端點對點直連 (WebRTC P2P E2EE)**。

[![macOS](https://img.shields.io/badge/macOS-13.0%2B-blue?logo=apple)](https://www.apple.com/macos/)
[![Android](https://img.shields.io/badge/Android-7.0%2B%20%28API%2024%2B%29-green?logo=android)](https://www.android.com/)
[![WebRTC](https://img.shields.io/badge/WebRTC-P2P%20DataChannel-orange?logo=webrtc)](https://webrtc.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## 💬 作者屁話

這個小垃圾是我為了解決安卓手機不能跟macbook傳airdrop所生的，目前用起來真的挺好用，但僅限於傳照片這樣的小檔案，太大的檔案會超時，這個日後慢慢處理。

---

## 🌟 核心特色 (Key Features)

* 📶 **跨網直連（免同 Wi-Fi 網路）**
  * 手機即使在戶外使用 **5G / 4G 行動網路**，Mac 連接家裡或辦公室寬頻 Wi-Fi，雙方依舊能秒速發現並直接傳檔。
* 🔥 **完全不需開啟手機熱點**
  * 徹底告別傳統「開熱點給 Mac 連」的繁瑣步驟！Mac 不需斷開現有網路，手機也不會因開熱點而發燙耗電。
* 🔒 **真正的端對端直連加密 (E2EE)**
  * 基於 **WebRTC DataChannel (SCTP over DTLS)** 技術。
  * 檔案直接在兩台裝置之間點對點傳輸，**不經過、不上傳任何第三方雲端伺服器**，保障極致隱私與線速頻寬。
* 📦 **批次多檔案高速穩定傳輸**
  * 實作 **Per-file ACK 握手協議** 與 **32KB / 512KB Backpressure 動態流控**。
  * 手機一次選取數十張高解析照片、長影片也不會超時卡死或丟包；自動整合行動瀏覽器防休眠 (WakeLock)。
* 🍏 **macOS 原生應用 (`CrossDrop.app`)**
  * 打包為完整 macOS 應用程式，可從 Spotlight (`Cmd + 空白鍵`) 或 Launchpad 啟動。
  * **背景全自動託管**：啟動時由 Swift 自動管理信令與加密通道，**日常使用完全不需打開終端機**。
  * **頂部狀態列常駐**：極簡 ⚡ 圖示，支援點擊呼叫傳輸面板、右鍵快捷選單與開機自動啟動 (Launch at Login)。
  * **完美相容瀏海螢幕 (Notch)**：內建狀態列座標防護與 Hidden Bar 收納工具相容性。
  * **獨立收件匣**：收到檔案自動存入 `~/Documents/CrossDrop_Received/`（與程式碼完全隔離），並彈出系統通知與提示音。
* 📱 **Android 雙模支援（免裝 App 即用 / 原生系統分享）**
  * **即時 PWA 體驗**：手機瀏覽器打開網址即可傳檔，可「新增至主螢幕」變身原生應用。
  * **原生 Kotlin 模組**：支援相簿與檔案管理員點擊「系統分享 (`ACTION_SEND`)」直接秒傳 Mac。

---

## 🏗️ 系統架構 (Architecture)

```text
[ Android 裝置 ]                                           [ macOS 裝置 ]
  📱 5G / 行動網路                                           💻 任何 Wi-Fi / 乙太網路
         │                                                        │
         │ (1) 初始信令握手 (WebSocket / Cloudflare Tunnel)         │
         ├───────────────────────────────────────────────────────►┤
         │                                                        │
         │ (2) STUN NAT 打洞 & DTLS 握手完成                      │
         │◄══════════════════════════════════════════════════════►│
         │                                                        │
         │ (3) 純點對點高速傳輸 (WebRTC DataChannel - SCTP)        │
         │═══════════════════════════════════════════════════════►│
         │     • 32KB 分塊串流 (Streaming)                         │
         │     • Backpressure 緩衝流量保護                        │
         │     • 每檔 ACK 存盤確認 (Batch Handshake)               │
         │                                                        │
```

---

## 📂 目錄結構 (Repository Layout)

```text
CrossDrop/
├── README.md               # 專案中文與技術說明文件
├── LICENSE                 # MIT 開源授權條款
├── .gitignore              # Git 忽略清單（排除編譯產物、快取與敏感設定）
├── start.sh                # 開發者終端機一鍵啟動腳本
│
├── mac/                    # macOS 原生應用模組 (Swift + AppKit + WebKit)
│   ├── main.swift          # App 主邏輯、背景服務守護、狀態列選單、收件管理
│   ├── build_app.sh        # 一鍵編譯並打包為 /Applications/CrossDrop.app
│   └── AppIcon.icns        # 高解析度 macOS App 專用圖標
│
├── signal/                 # 輕量信令與 Web 伺服器模組 (Node.js + WebSocket)
│   ├── server.js           # 房間配對、SDP/ICE 中繼、QR Code 生成 API
│   ├── package.json        # 依賴套件 (ws, qrcode)
│   └── test_signaling.js   # 信令單元自動化測試
│
├── web/                    # 即時 Web PWA 前端 (免安裝瀏覽器客戶端)
│   ├── index.html          # AirDrop 風格雷達掃描與拖放傳檔 UI
│   ├── app.js              # WebRTC P2P 引擎、ACK 握手、分塊傳輸與進度管理
│   ├── style.css           # 毛玻璃深色主題樣式
│   └── manifest.json       # PWA Progressive Web App 配置
│
└── android/                # Android 原生模組 (Kotlin + AndroidX + WebRTC)
    ├── app/
    │   ├── src/main/
    │   │   ├── AndroidManifest.xml # 註冊系統分享選單 (ACTION_SEND)
    │   │   └── java/com/crossdrop/
    │   │       ├── MainActivity.kt    # 主控台面板
    │   │       ├── SendActivity.kt    # 系統分享快捷發送
    │   │       ├── ReceiveService.kt  # 背景常駐接收服務
    │   │       ├── WebRTCManager.kt   # WebRTC 直連核心
    │   │       └── SignalingClient.kt # WebSocket 信令客戶端
    │   └── build.gradle
    └── settings.gradle
```

---

## 🚀 快速上手 (Quick Start)

### 步驟 1：安裝並啟動 Mac 端

#### 方式 A：一鍵編譯並安裝至「應用程式」目錄（推薦）
本專案需要本機具備 `node` 與 `cloudflared`（用於 5G 跨網穿透）：
```bash
# 透過 Homebrew 安裝必備環境（若尚未安裝）
brew install node cloudflared

# Clone 專案
git clone https://github.com/<your-username>/CrossDrop.git
cd CrossDrop

# 編譯並安裝到 /Applications
cd mac
./build_app.sh
```
編譯完成後，`CrossDrop.app` 即安裝至您的 `/Applications` 資料夾：
1. 按 `Cmd + 空白鍵`（Spotlight）輸入 `CrossDrop` 即可開啟。
2. 頂部狀態列會常駐一個簡約的 **⚡ 閃電圖示**，傳輸視窗自動打開。
3. **完全不需打開終端機**，App 會在背景全自動啟動信令與 5G 加密穿透。

#### 方式 B：開發者命令列啟動
```bash
./start.sh
```

---

### 步驟 2：在 Android 端連接體驗

#### 體驗方式 A：免安裝任何 App（最快體驗，推薦）
1. 在 Mac 頂部的 **⚡** 圖示按滑鼠右鍵，點擊「**📋 複製 5G 網址**」（或在傳送面板點擊 QR Code）。
2. 在 Android 手機上的 **Chrome / 任何瀏覽器** 打開該網址（即使手機使用 5G/4G 網路也完全暢通）。
3. 點擊瀏覽器右上角選單「**加到主畫面 (Add to Home Screen)**」，即可像原生 App 一樣全螢幕使用。
4. 在手機畫面上點選檔案拖放區，選取**多張照片或長影片**，即可秒傳至 Mac！

#### 體驗方式 B：Android 原生 App（支援系統相簿直接分享）
1. 使用 **Android Studio** 開啟專案中的 `android/` 目錄。
2. 編譯並安裝到手機上。
3. 日後在手機相簿中選取照片或影片，點擊「**分享**」-> 選取「**CrossDrop**」，就能像原生 AirDrop 一樣直接發送至 Mac！

---

## 📥 檔案存放位置

* **Mac 接收端**：
  * 所有收到的檔案獨立存放於：  
    👉 `~/Documents/CrossDrop_Received/`（「文件」目錄下的 `CrossDrop_Received` 資料夾）
  * 自動避免同名檔案覆蓋（例如 `photo_1.jpg`, `photo_2.jpg`）。
  * 傳輸完成後 Mac 會自動發出原生橫幅通知與提示音。
* **Android 接收端**：
  * 存放在系統 `Download/CrossDrop/` 目錄，自動觸發 MediaScanner 讓相片即時出現在手機相簿中。

---

## 🛠️ 技術規格與實現細節

| 規格維度 | 具體實現與參數 |
| :--- | :--- |
| **P2P 直連協議** | WebRTC DataChannel (SCTP over DTLS 1.2+ / UDP) |
| **公網 NAT 穿透** | Google 公用 STUN (`stun.l.google.com:19302`) |
| **5G 跨網隧道** | Cloudflare Quick Tunnel (`trycloudflare.com` 全自動隨機加密通道) |
| **分塊傳輸大小** | 32 KB / Chunk（經最佳化，符合行動網路 MTU 封包上限，防丟包） |
| **流量控制** | 512 KB 緩衝區門檻 + 35ms 輪詢 Fallback（徹底防止信道死鎖） |
| **批次傳輸協議** | Per-file ACK Handshake（每檔磁碟寫入確認後才傳下一檔） |
| **防休眠技術** | Screen WakeLock API（防止傳輸大檔案時手機螢幕休眠斷線） |
| **macOS 狀態列** | AppKit `NSStatusItem`，支援 `autosaveName` 與 `Preferred Position` |
| **開機自動啟動** | macOS 13+ `SMAppService.mainApp` 原生介面 |

---

## ❓ 常見問題 (FAQ)

#### Q1：在配備瀏海（Notch）的 MacBook 上，頂部狀態列看不到圖示？
CrossDrop 內建了狀態列偏好排序優化（`autosaveName`），預設會出現在狀態列外側的常駐顯示區。如果您有使用 **Hidden Bar** 或 **Bartender** 等收納軟體：
* 點擊展開箭頭即可看到 ⚡ 圖示。
* 按住鍵盤 `Cmd`（⌘）鍵，用滑鼠直接拖曳 ⚡ 圖示到 WiFi 或電池旁邊，即可永遠固定在最外層！

#### Q2：手機一次傳多張照片會不會超時卡住？
不會！CrossDrop 在最新版本實作了「端對端 ACK 握手協議」。發送端會等到 Mac 成功將前一個檔案寫入磁碟並返回確認信號後，才繼續推送下一個檔案，徹底解決了一次發送大量檔案時瀏覽器緩衝區溢出的問題。

#### Q3：在 Dock 點擊 CrossDrop 可以打開視窗嗎？
可以！CrossDrop 完全支援 Dock 整合：
* 點擊 Dock 上的 ⚡ 圖示可一鍵將視窗喚至最上層。
* 在 Dock 圖示上按滑鼠右鍵，也可以快速複製 5G 網址或打開收件匣。

---

## 📄 開源授權 (License)

本專案採用 [MIT License](LICENSE) 授權開源，歡迎自由使用、修改與二次開發！
