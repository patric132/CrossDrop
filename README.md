# ⚡ CrossDrop

> **Android 與 macOS 之間真正自由的高速直連傳檔神器（AirDrop 完美跨界替代方案）**  
> 突破 Apple 生態限制：**免同 Wi-Fi**、**免開手機熱點**、**端對端點對點直連 (WebRTC P2P E2EE)**。

[![macOS](https://img.shields.io/badge/macOS-13.0%2B-blue?logo=apple)](https://www.apple.com/macos/)
[![Android](https://img.shields.io/badge/Android-7.0%2B%20%28API%2024%2B%29-green?logo=android)](https://www.android.com/)
[![WebRTC](https://img.shields.io/badge/WebRTC-P2P%20DataChannel-orange?logo=webrtc)](https://webrtc.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## 💬 作者屁話

這個小垃圾是我為了解決安卓手機不能跟macbook傳airdrop所生的，目前用起來真的挺好用。原本傳太大的檔案或影片會超時，現在也已經搞定處理好了，照片跟影片都能順順秒傳！

---

## 🌟 核心特色 (Key Features)

* 📶 **跨網直連（免同 Wi-Fi 網路）**
  * 手機即使在戶外使用 **5G / 4G 行動網路**，Mac 連接家裡或辦公室寬頻 Wi-Fi，雙方依舊能秒速發現並直接傳檔。
* 🔥 **完全不需開啟手機熱點**
  * 徹底告別傳統「開熱點給 Mac 連」的繁瑣步驟！Mac 不需斷開現有網路，手機也不會因開熱點而發燙耗電。
* 🔒 **真正的端對端直連加密 (E2EE)**
  * 基於 **WebRTC DataChannel (SCTP over DTLS 1.2+)** 技術。
  * 傳輸通道使用高強度非對稱握手與對稱密碼學加密，中間人無法窺探或竄改。
  * 檔案直接在兩台裝置之間點對點高速傳輸，**不經過、不上傳任何第三方雲端伺服器**。
* 🛡️ **全面資安強化架構 (Security Hardening)**
  * **動態隨機房間 (256-bit Entropy)**：廢除任何公開或預設房間名稱，每次連線皆為獨立隔離房間。
  * **一次性配對 Token**：透過 QR Code 或 5G 連結傳遞之 Token 採單次使用即失效機制，杜絕連結被重送攻擊 (Replay Attack)。
  * **6 位數 PIN 碼防暴力破解**：支援手動輸入 PIN 配對，內建 5 次失敗即鎖定 15 分鐘機制，防止隨機撞庫。
  * **檔案接收確認機制 (Transfer Consent)**：發送檔案前必須在接收端 UI 彈出原生確認視窗（顯示發送者、檔名、大小），經接收端點選「接受」後才啟動傳輸；未經授權之二進位 Chunks 一律強制捨棄。
  * **檔案大小與溢出防護**：強制限制單一檔案大小上限為 10 GB，並在串流過程中實時校驗已接收位元組數（`receivedBytes <= declaredSize`），超量立即中斷傳輸。
  * **檔案名稱安全淨化**：防止目錄穿越（`../`）、控制字元與 XSS 注入攻擊。
* 📦 **批次多檔案高速穩定傳輸**
  * 實作 **Per-file ACK 握手協議** 與 **64KB / 1MB Backpressure 動態流控**。
  * 手機一次選取數十張高解析照片、4K 長影片也不會超時卡死或丟包；自動整合行動瀏覽器防休眠 (WakeLock)。
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

## 🏗️ 系統架構與資料流 (Architecture & Security Model)

```text
[ Android 裝置 ]                                           [ macOS 裝置 ]
  📱 5G / 行動網路                                           💻 任何 Wi-Fi / 乙太網路
         │                                                        │
         │ (1) 信令握手 (WebSocket over Cloudflare Tunnel)         │
         │     • 僅交換 SDP Offer/Answer 與 ICE Candidates        │
         │     • 嚴格隔離 Room，禁止跨房間信令轉發                 │
         │     • 絕不經手任何檔案內容與二進位數據                   │
         ├───────────────────────────────────────────────────────►┤
         │                                                        │
         │ (2) STUN NAT 打洞 & WebRTC DTLS 握手完成               │
         │◄══════════════════════════════════════════════════════►│
         │                                                        │
         │ (3) 傳輸授權 (Transfer Consent Protocol)                │
         │     • 發送端推送 transfer-request (檔名/大小/發送者)     │
         │     • 接收端彈出確認對話框，經使用者點擊「接受」          │
         │     • 接收端回覆 transfer-accept 授權傳輸                │
         │◄══════════════════════════════════════════════════════►│
         │                                                        │
         │ (4) 純點對點高速加密傳輸 (WebRTC DataChannel - SCTP/DTLS) │
         │═══════════════════════════════════════════════════════►│
         │     • 64KB 分塊串流 (Streaming)                         │
         │     • 1MB Backpressure 緩衝流量保護                     │
         │     • receivedBytes > declaredSize 溢出即時阻斷防護     │
         │     • 每檔 ACK 存盤確認 (Batch Handshake)               │
         │                                                        │
```

> **資安特別說明**：
> 1. **WebRTC DataChannel 安全性**：傳輸通道採用標準 DTLS 加密協議，提供端對端機密性與完整性保證。
> 2. **Signaling Server 職責純化**：信令伺服器僅作為建立 P2P 連線初期的 SDP/ICE 中繼站，無權限也不會接觸到任何檔案本體。
> 3. **Cloudflare Tunnel 角色定位**：僅用於讓手機在外網（如 5G）能存取 Mac 上的信令伺服器與 Web 靜態頁面，後續所有檔案傳輸均切換為直接 P2P WebRTC 傳輸通道。

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
| **P2P 直連協議** | WebRTC DataChannel (SCTP over DTLS 1.2+ / UDP 端對端加密) |
| **公網 NAT 穿透** | Google 公用 STUN (`stun.l.google.com:19302`) + Cloudflare STUN |
| **5G 跨網信令通道** | Cloudflare Quick Tunnel (`trycloudflare.com` 自動加密通道，僅供信令中繼) |
| **房間與授權機制** | 256-bit CSPRNG 隔離房間 + 一次性 QR 配對 Token + 6 位數 PIN 碼 (5 次錯誤鎖定 15 分鐘) |
| **檔案接收授權** | Transfer Consent Protocol（發送端預先申報，接收端 UI 顯式確認後方可傳輸） |
| **單檔大小上限** | 10 GB (強制邊界檢核與串流實時 overflow guard 雙重保險) |
| **分塊傳輸大小** | 64 KB / Chunk（標準 WebRTC MTU 最佳尺寸，防丟包與延遲） |
| **流量控制** | 1 MB 緩衝區門檻 + bufferedamountlow 事件驅動流控（防死鎖與記憶體溢出） |
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
