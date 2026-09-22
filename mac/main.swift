import Cocoa
import WebKit
import ServiceManagement

class CrossDropApp: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate, NSWindowDelegate {
    var statusItem: NSStatusItem!
    var window: NSWindow!
    var webView: WKWebView!
    var storageURL: URL!
    var connectedPeers: [String: String] = [:] // id -> name
    var lastSelectedPeerId: String? = nil

    var nodeProcess: Process?
    var cloudflaredProcess: Process?
    var publicURL: String? = nil
    var cloudflaredOutputPipe: Pipe?

    var tunnelHealthTimer: Timer?
    var consecutiveTunnelFailures: Int = 0
    var isRestartingTunnel: Bool = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        // 1. Setup Documents/CrossDrop_Received independent storage directory
        let userDocs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        storageURL = userDocs.appendingPathComponent("CrossDrop_Received")
        try? FileManager.default.createDirectory(at: storageURL, withIntermediateDirectories: true, attributes: nil)

        // 2. Start Background Services (Node.js & Cloudflare Tunnel)
        startBackgroundServices()

        // 3. Start Tunnel Health Supervisor
        startTunnelSupervisor()

        // 4. Register for system sleep/wake notifications
        NSWorkspace.shared.notificationCenter.addObserver(
            self,
            selector: #selector(handleSystemWake(_:)),
            name: NSWorkspace.didWakeNotification,
            object: nil
        )

        // 5. Setup Web Engine
        setupWebEngine()

        // 6. Setup Native GUI Window
        setupWindow()

        // 7. Setup Status Bar Item
        setupStatusBar()

        print("[CrossDrop Mac] Started successfully. Saving files to: \(storageURL.path)")
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopBackgroundServices()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindowFront()
        return true
    }

    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        let menu = NSMenu()
        let winItem = NSMenuItem(title: "📱 顯示 CrossDrop 視窗", action: #selector(showWindowFront), keyEquivalent: "")
        winItem.target = self
        menu.addItem(winItem)

        if publicURL != nil {
            let copyItem = NSMenuItem(title: "📋 複製 5G 網址", action: #selector(copyPublicURL), keyEquivalent: "")
            copyItem.target = self
            menu.addItem(copyItem)
        }

        let folderItem = NSMenuItem(title: "📂 打開收件資料夾", action: #selector(openDocumentsFolder), keyEquivalent: "")
        folderItem.target = self
        menu.addItem(folderItem)

        return menu
    }

    // MARK: - Background Service Management
    func findExecutable(name: String) -> String {
        let candidates = [
            "/opt/homebrew/bin/\(name)",
            "/usr/local/bin/\(name)",
            "/usr/bin/\(name)",
            (Bundle.main.resourcePath ?? "") + "/bin/\(name)"
        ]
        for c in candidates {
            if FileManager.default.isExecutableFile(atPath: c) {
                return c
            }
        }
        return name
    }

    func startBackgroundServices() {
        // Clean up any zombie processes
        let killNode = Process()
        killNode.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        killNode.arguments = ["-f", "node server.js"]
        try? killNode.run()
        killNode.waitUntilExit()

        let bundleRes = Bundle.main.resourcePath ?? ""
        var signalDir = bundleRes + "/signal"
        if !FileManager.default.fileExists(atPath: signalDir + "/server.js") {
            signalDir = FileManager.default.homeDirectoryForCurrentUser.path + "/Documents/CrossDrop/signal"
        }

        var webDir = bundleRes + "/web"
        if !FileManager.default.fileExists(atPath: webDir + "/index.html") {
            webDir = FileManager.default.homeDirectoryForCurrentUser.path + "/Documents/CrossDrop/web"
        }

        // 1. Start Node.js Signaling Server
        let nodePath = findExecutable(name: "node")
        let nProc = Process()
        nProc.executableURL = URL(fileURLWithPath: nodePath)
        nProc.arguments = ["server.js"]
        nProc.currentDirectoryURL = URL(fileURLWithPath: signalDir)
        var env = ProcessInfo.processInfo.environment
        env["CROSSDROP_WEB_DIR"] = webDir
        nProc.environment = env
        do {
            try nProc.run()
            self.nodeProcess = nProc
            print("[CrossDrop Mac] Node server started (PID: \(nProc.processIdentifier))")
        } catch {
            print("[CrossDrop Mac] Failed to start node server: \(error)")
        }

        // 2. Start Cloudflare Tunnel
        startCloudflareTunnel()
    }

    func startCloudflareTunnel() {
        stopCloudflareTunnel()

        let cfPath = findExecutable(name: "cloudflared")
        let cfProc = Process()
        cfProc.executableURL = URL(fileURLWithPath: cfPath)
        cfProc.arguments = ["tunnel", "--url", "http://localhost:3000"]
        let pipe = Pipe()
        cfProc.standardOutput = pipe
        cfProc.standardError = pipe
        self.cloudflaredOutputPipe = pipe

        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            if let range = text.range(of: "https://[a-zA-Z0-9-]+\\.trycloudflare\\.com", options: .regularExpression) {
                let url = String(text[range])
                DispatchQueue.main.async {
                    self?.onPublicURLDiscovered(url)
                }
            }
        }

        cfProc.terminationHandler = { [weak self] proc in
            print("[CrossDrop Mac] Cloudflared process exited (code \(proc.terminationStatus)).")
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                if self?.cloudflaredProcess == nil {
                    self?.startCloudflareTunnel()
                }
            }
        }

        do {
            try cfProc.run()
            self.cloudflaredProcess = cfProc
            print("[CrossDrop Mac] Cloudflared tunnel started (PID: \(cfProc.processIdentifier))")
        } catch {
            print("[CrossDrop Mac] Failed to start cloudflared: \(error)")
        }
    }

    func stopCloudflareTunnel() {
        cloudflaredOutputPipe?.fileHandleForReading.readabilityHandler = nil
        cloudflaredProcess?.terminationHandler = nil
        cloudflaredProcess?.terminate()
        cloudflaredProcess = nil
    }

    @objc func restartCloudflareTunnel() {
        guard !isRestartingTunnel else { return }
        isRestartingTunnel = true
        print("[CrossDrop Mac] Restarting Cloudflare Tunnel...")

        self.publicURL = nil
        self.consecutiveTunnelFailures = 0

        // Inform Web UI that tunnel is renewing
        let payload: [String: Any] = ["reconnecting": true]
        if let jsonData = try? JSONSerialization.data(withJSONObject: payload),
           let jsonString = String(data: jsonData, encoding: .utf8) {
            self.webView.evaluateJavaScript("window.setTunnelReconnecting && window.setTunnelReconnecting(\(jsonString));", completionHandler: nil)
        }

        stopCloudflareTunnel()

        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
            self?.startCloudflareTunnel()
            self?.isRestartingTunnel = false
        }
    }

    func startTunnelSupervisor() {
        tunnelHealthTimer?.invalidate()
        tunnelHealthTimer = Timer.scheduledTimer(withTimeInterval: 25.0, repeats: true) { [weak self] _ in
            self?.checkTunnelHealth()
        }
    }

    func checkTunnelHealth() {
        guard !isRestartingTunnel else { return }

        // 1. Process liveness check
        if cloudflaredProcess == nil || !(cloudflaredProcess?.isRunning ?? false) {
            print("[CrossDrop Mac] Cloudflare process is not running. Reviving...")
            restartCloudflareTunnel()
            return
        }

        // 2. End-to-end connectivity check
        guard let urlString = self.publicURL, let url = URL(string: "\(urlString)/health") else {
            return
        }

        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.timeoutInterval = 7.0
        req.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData

        let task = URLSession.shared.dataTask(with: req) { [weak self] (data, response, error) in
            guard let self = self else { return }
            let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
            if error != nil || statusCode != 200 {
                self.consecutiveTunnelFailures += 1
                print("[CrossDrop Mac] Tunnel health check failed (\(statusCode), err: \(error?.localizedDescription ?? "none"), fail count: \(self.consecutiveTunnelFailures))")
                if self.consecutiveTunnelFailures >= 2 {
                    print("[CrossDrop Mac] Tunnel confirmed unresponsive. Automatically auto-healing...")
                    DispatchQueue.main.async {
                        self.restartCloudflareTunnel()
                    }
                }
            } else {
                self.consecutiveTunnelFailures = 0
            }
        }
        task.resume()
    }

    @objc func handleSystemWake(_ notification: Notification) {
        print("[CrossDrop Mac] System woke from sleep. Reconnecting tunnel in 3 seconds...")
        showSystemNotification(title: "CrossDrop", body: "系統已喚醒，正在自動重新建立 5G 加密連線...")
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) { [weak self] in
            self?.restartCloudflareTunnel()
        }
    }

    func onPublicURLDiscovered(_ url: String) {
        if self.publicURL == url { return }
        self.publicURL = url
        self.consecutiveTunnelFailures = 0
        print("[CrossDrop Mac] 5G Public URL discovered: \(url)")

        showSystemNotification(title: "CrossDrop Ready! ⚡", body: "手機掃描 QR Code 或打開網址連線")
        let payload: [String: Any] = ["url": url]
        if let jsonData = try? JSONSerialization.data(withJSONObject: payload),
           let jsonString = String(data: jsonData, encoding: .utf8) {
            let js = "window.setPublicUrlJSON && window.setPublicUrlJSON(\(jsonString));"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    func stopBackgroundServices() {
        tunnelHealthTimer?.invalidate()
        tunnelHealthTimer = nil
        nodeProcess?.terminate()
        stopCloudflareTunnel()
    }

    // MARK: - Status Bar & Context Menu
    func setupStatusBar() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.autosaveName = NSStatusItem.AutosaveName("CrossDropStatusItem")
        if let button = statusItem.button {
            let symbolConfig = NSImage.SymbolConfiguration(pointSize: 15, weight: .semibold)
            if let image = NSImage(systemSymbolName: "bolt.fill", accessibilityDescription: "CrossDrop")?.withSymbolConfiguration(symbolConfig) {
                image.isTemplate = true
                button.image = image
            } else {
                button.title = "⚡"
            }
            button.action = #selector(statusBarButtonClicked(_:))
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
            button.target = self
            button.toolTip = "CrossDrop - 點擊開關視窗，右鍵打開選單"
        }
    }

    @objc func statusBarButtonClicked(_ sender: NSStatusBarButton) {
        let event = NSApp.currentEvent
        if event?.type == .rightMouseUp {
            showContextMenu()
        } else {
            toggleWindow()
        }
    }

    @objc func toggleWindow() {
        if window.isVisible && window.isKeyWindow {
            window.orderOut(nil)
        } else {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    func showContextMenu() {
        let menu = NSMenu()

        let statusTitle = connectedPeers.isEmpty ? "📡 狀態: 監聽設備中..." : "🟢 已連線 (\(connectedPeers.count) 台裝置)"
        let headerItem = NSMenuItem(title: statusTitle, action: nil, keyEquivalent: "")
        headerItem.isEnabled = false
        menu.addItem(headerItem)

        menu.addItem(NSMenuItem.separator())

        // 5G URL copy
        if let url = publicURL {
            let copyItem = NSMenuItem(title: "📱 5G 網址: \(url) (點擊複製)", action: #selector(copyPublicURL), keyEquivalent: "")
            copyItem.target = self
            menu.addItem(copyItem)
        } else {
            let tunnelItem = NSMenuItem(title: "⏳ 正在建立 5G 加密連線...", action: nil, keyEquivalent: "")
            tunnelItem.isEnabled = false
            menu.addItem(tunnelItem)
        }

        let restartTunnelItem = NSMenuItem(title: "🔄 重新建立 5G 連線 (刷新 QR Code)", action: #selector(restartCloudflareTunnel), keyEquivalent: "r")
        restartTunnelItem.target = self
        menu.addItem(restartTunnelItem)

        menu.addItem(NSMenuItem.separator())

        let showWinItem = NSMenuItem(title: "📱 顯示 CrossDrop 視窗", action: #selector(showWindowFront), keyEquivalent: "")
        showWinItem.target = self
        menu.addItem(showWinItem)

        let sendItem = NSMenuItem(title: "📤 發送檔案到手機...", action: #selector(sendFilePrompt), keyEquivalent: "s")
        sendItem.target = self
        menu.addItem(sendItem)

        let openFolderItem = NSMenuItem(title: "📂 打開收件資料夾 (CrossDrop_Received)", action: #selector(openDocumentsFolder), keyEquivalent: "o")
        openFolderItem.target = self
        menu.addItem(openFolderItem)

        menu.addItem(NSMenuItem.separator())

        if #available(macOS 13.0, *) {
            let isAuto = (SMAppService.mainApp.status == .enabled)
            let autoItem = NSMenuItem(title: isAuto ? "✓ 開機自動啟動" : "開機自動啟動", action: #selector(toggleLaunchAtLogin), keyEquivalent: "")
            autoItem.target = self
            menu.addItem(autoItem)
        }

        menu.addItem(NSMenuItem.separator())

        let quitItem = NSMenuItem(title: "結束 CrossDrop", action: #selector(quitApp), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        statusItem.popUpMenu(menu)
    }

    @objc func copyPublicURL() {
        if let url = publicURL {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(url, forType: .string)
            showSystemNotification(title: "網址已複製 📋", body: url)
        }
    }

    @objc func toggleLaunchAtLogin() {
        if #available(macOS 13.0, *) {
            do {
                if SMAppService.mainApp.status == .enabled {
                    try SMAppService.mainApp.unregister()
                    showSystemNotification(title: "CrossDrop", body: "已關閉開機自動啟動")
                } else {
                    try SMAppService.mainApp.register()
                    showSystemNotification(title: "CrossDrop", body: "已開啟開機自動在狀態列啟動")
                }
            } catch {
                print("[CrossDrop] SMAppService error: \(error)")
            }
        }
    }

    @objc func showWindowFront() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func setupWindow() {
        let rect = NSRect(x: 0, y: 0, width: 480, height: 680)
        window = NSWindow(contentRect: rect,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered,
                          defer: false)
        window.title = "⚡ CrossDrop"
        window.center()
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.contentView = webView
        window.minSize = NSSize(width: 400, height: 540)

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        window.orderOut(nil)
        return false
    }

    func setupWebEngine() {
        let contentController = WKUserContentController()
        contentController.add(self, name: "crossdropNative")

        let config = WKWebViewConfiguration()
        config.userContentController = contentController
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self

        // Load after small delay to give node server time to listen
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            let url = URL(string: "http://localhost:3000/")!
            self?.webView.load(URLRequest(url: url))
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        // Auto retry if server is still starting up
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            let url = URL(string: "http://localhost:3000/")!
            webView.load(URLRequest(url: url))
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if let url = publicURL {
            let payload: [String: Any] = ["url": url]
            if let jsonData = try? JSONSerialization.data(withJSONObject: payload),
               let jsonString = String(data: jsonData, encoding: .utf8) {
                let js = "window.setPublicUrlJSON && window.setPublicUrlJSON(\(jsonString));"
                webView.evaluateJavaScript(js, completionHandler: nil)
            }
        }
    }

    // Bridge from JavaScript
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let dict = message.body as? [String: Any],
              let type = dict["type"] as? String else { return }

        switch type {
        case "peers-updated":
            if let list = dict["peers"] as? [[String: Any]] {
                connectedPeers.removeAll()
                for p in list {
                    if let id = p["deviceId"] as? String, let name = p["deviceName"] as? String {
                        connectedPeers[id] = name
                        lastSelectedPeerId = id
                    }
                }
            }

        case "file-saved-notification":
            if let name = dict["name"] as? String,
               let size = dict["size"] as? Int {
                DispatchQueue.main.async {
                    self.showSystemNotification(title: "收到檔案！⚡", body: "\(name) (\(self.formatBytes(size))) 已存入 Documents/CrossDrop_Received")
                    self.playTuturuSound()
                }
            }

        case "file-received":
            if let name = dict["name"] as? String,
               let base64 = dict["base64"] as? String,
               let data = Data(base64Encoded: base64) {
                saveReceivedFile(name: name, data: data)
            }

        case "transfer-progress":
            if let percent = dict["percent"] as? Int {
                DispatchQueue.main.async {
                    if let button = self.statusItem.button {
                        button.title = ""
                        button.toolTip = "CrossDrop - 正在傳輸 (\(percent)%)"
                    }
                }
            }

        case "transfer-complete":
            DispatchQueue.main.async {
                if let button = self.statusItem.button {
                    button.title = ""
                    button.toolTip = "CrossDrop - 點擊開關視窗，右鍵打開選單"
                }
            }

        case "restart-tunnel":
            DispatchQueue.main.async {
                self.restartCloudflareTunnel()
            }

        default:
            break
        }
    }

    func saveReceivedFile(name: String, data: Data) {
        var targetFile = storageURL.appendingPathComponent(name)
        var counter = 1
        let ext = targetFile.pathExtension
        let baseName = targetFile.deletingPathExtension().lastPathComponent

        while FileManager.default.fileExists(atPath: targetFile.path) {
            let newName = "\(baseName)_\(counter).\(ext)"
            targetFile = storageURL.appendingPathComponent(newName)
            counter += 1
        }

        do {
            try data.write(to: targetFile)
            print("[CrossDrop Mac] Saved file to: \(targetFile.path)")
            showSystemNotification(title: "收到檔案！⚡", body: "\(name) (\(formatBytes(data.count))) 已存入 Documents/CrossDrop_Received")
            playTuturuSound()
        } catch {
            print("[CrossDrop Mac] Failed to save file: \(error)")
        }
    }

    func playTuturuSound() {
        if let sound = NSSound(named: "tuturu") {
            sound.play()
            return
        }
        if let resPath = Bundle.main.path(forResource: "tuturu", ofType: "aiff"),
           let sound = NSSound(contentsOfFile: resPath, byReference: true) {
            sound.play()
            return
        }
        NSSound(named: "Glass")?.play()
    }

    func showSystemNotification(title: String, body: String) {
        let cleanTitle = title.replacingOccurrences(of: "\"", with: "\\\"")
        let cleanBody = body.replacingOccurrences(of: "\"", with: "\\\"")
        let script = "display notification \"\(cleanBody)\" with title \"\(cleanTitle)\""
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", script]
        try? process.run()
    }

    @objc func sendFilePrompt() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        panel.prompt = "發送"

        if panel.runModal() == .OK {
            for url in panel.urls {
                sendFileToPeer(fileURL: url)
            }
        }
    }

    func sendFileToPeer(fileURL: URL) {
        guard let peerId = lastSelectedPeerId ?? connectedPeers.keys.first else {
            let alert = NSAlert()
            alert.messageText = "尚未連線到手機"
            alert.informativeText = "請確保手機已透過 5G 網址開啟 CrossDrop。"
            alert.runModal()
            return
        }

        do {
            let data = try Data(contentsOf: fileURL)
            let base64 = data.base64EncodedString()
            let fileName = fileURL.lastPathComponent
            let mimeType = "application/octet-stream"

            let payload: [String: Any] = [
                "targetId": peerId,
                "name": fileName,
                "size": data.count,
                "mime": mimeType,
                "base64": base64
            ]
            if let jsonData = try? JSONSerialization.data(withJSONObject: payload),
               let jsonString = String(data: jsonData, encoding: .utf8) {
                let js = "window.nativeSendFileJSON && window.nativeSendFileJSON(\(jsonString));"
                webView.evaluateJavaScript(js, completionHandler: nil)
                print("[CrossDrop Mac] Initiating send of \(fileName) (\(data.count) bytes) to \(peerId)")
            }
        } catch {
            print("[CrossDrop Mac] Error reading file: \(error)")
        }
    }

    @objc func openDocumentsFolder() {
        NSWorkspace.shared.open(storageURL)
    }

    @objc func quitApp() {
        stopBackgroundServices()
        NSApplication.shared.terminate(self)
    }

    func formatBytes(_ bytes: Int) -> String {
        let formatter = ByteCountFormatter()
        formatter.allowedUnits = [.useKB, .useMB, .useGB]
        formatter.countStyle = .file
        return formatter.string(fromByteCount: Int64(bytes))
    }
}

// Entry point
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = CrossDropApp()
app.delegate = delegate
app.run()
