import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

@MainActor
final class WorkspaceMonitor: NSObject {
    typealias ActivationHandler = @MainActor (NSRunningApplication) -> Void

    private let onActivation: ActivationHandler
    private var started = false

    init(onActivation: @escaping ActivationHandler) {
        self.onActivation = onActivation
    }

    func start() {
        guard !started else {
            return
        }
        started = true
        NSWorkspace.shared.notificationCenter.addObserver(
            self,
            selector: #selector(applicationActivated(_:)),
            name: NSWorkspace.didActivateApplicationNotification,
            object: nil
        )
        if let frontmost = NSWorkspace.shared.frontmostApplication {
            onActivation(frontmost)
        }
    }

    func stop() {
        guard started else {
            return
        }
        started = false
        NSWorkspace.shared.notificationCenter.removeObserver(self)
    }

    @objc private func applicationActivated(_ notification: Notification) {
        guard let application = notification.userInfo?[
            NSWorkspace.applicationUserInfoKey
        ] as? NSRunningApplication else {
            return
        }
        onActivation(application)
    }
}

@MainActor
final class ObserverRuntime: @unchecked Sendable {
    private let emitter = FrameEmitter()
    private lazy var commandInput = CommandInput(runtime: self)
    private lazy var workspaceMonitor = WorkspaceMonitor { [weak self] application in
        self?.handleForegroundApplication(application)
    }
    private lazy var accessibilityMonitor = AccessibilityMonitor { [weak self] snapshot in
        self?.handleAccessibilitySnapshot(snapshot)
    }
    private lazy var inputMonitor = InputActivityMonitor(
        onBucket: { [weak self] bucket in
            Task { @MainActor in
                self?.handleInputBucket(bucket)
            }
        },
        onClick: { [weak self] point in
            Task { @MainActor in
                self?.handleClick(at: point)
            }
        },
        onActivity: { [weak self] in
            Task { @MainActor in
                self?.handleInputActivity()
            }
        }
    )
    private lazy var screenOCRMonitor = ScreenOCRMonitor(
        onResult: { [weak self] result in
            self?.handleOCRResult(result)
        },
        onGap: { [weak self] code in
            self?.handleOCRGap(code)
        }
    )
    private let browserMetadataReader = BrowserMetadataReader()
    private var heartbeatTimer: Timer?
    private var state = "idle"
    private var configuration = ObserverConfiguration(dictionary: nil)
    private var activeApplication: NSRunningApplication?
    private var lastPermissionSnapshot: PermissionSnapshot?
    private var targetGeneration: UInt64 = 0
    private var lastHashes: [String: Int] = [:]
    private var activeCaptureAllowed = false
    private static let redactedCoverageGapReasons: Set<String> = [
        "user_excluded_application",
        "sensitive_application",
        "sensitive_or_private_window",
        "protected_input",
        "private_window",
        "sensitive_visible_content",
        "sensitive_focused_control",
        "sensitive_final_value",
        "protected_content",
    ]
    private static let unavailableCoverageGapReasons: Set<String> = [
        "browser_privacy_state_unavailable",
        "thermal_critical",
        "foreground_window_unavailable",
        "screen_capture_failed",
    ]

    func run() {
        guard #available(macOS 14.0, *) else {
            emitter.emitError(code: "unsupported_macos_version", recoverable: false)
            exit(EXIT_FAILURE)
        }
        let permissions = permissionSnapshot(prompt: false)
        lastPermissionSnapshot = permissions
        emitter.emitReady(permissionSnapshot: permissions)
        heartbeatTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) {
            [weak self] _ in
            MainActor.assumeIsolated {
                self?.emitHeartbeat()
            }
        }
        commandInput.start()
    }

    func handleCommandData(_ data: Data) {
        guard let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any],
              let type = dictionary["type"] as? String
        else {
            protocolFailure(code: "invalid_json")
            return
        }
        if type == "ack" {
            guard let bootId = dictionary["bootId"] as? String,
                  let sequence = unsignedInteger(dictionary["sequence"])
            else {
                protocolFailure(code: "invalid_ack")
                return
            }
            emitter.acknowledge(bootId: bootId, through: sequence)
            return
        }
        guard type == "command",
              let id = bounded(dictionary["id"] as? String, limit: 128),
              let command = dictionary["command"] as? String
        else {
            protocolFailure(code: "invalid_command")
            return
        }

        switch command {
        case "start":
            configuration = ObserverConfiguration(
                dictionary: dictionary["config"] as? [String: Any]
            )
            startMonitoring()
            emitter.emitCommandResult(id: id, ok: true, state: state)
        case "pause":
            stopMonitoring(nextState: "paused")
            emitter.emitCommandResult(id: id, ok: true, state: state)
        case "resume":
            startMonitoring()
            emitter.emitCommandResult(id: id, ok: true, state: state)
        case "status":
            let permissions = permissionSnapshot(prompt: false)
            lastPermissionSnapshot = permissions
            emitter.emitPermissionStatus(permissions)
            emitter.emitCommandResult(id: id, ok: true, state: state)
        case "refreshPermissions":
            let prompt = dictionary["prompt"] as? Bool ?? false
            if prompt {
                requestPermissions(id: id)
                return
            }
            let permissions = permissionSnapshot(prompt: prompt)
            let changed = permissions != lastPermissionSnapshot
            lastPermissionSnapshot = permissions
            emitter.emitPermissionStatus(permissions)
            if changed, state == "running" {
                stopMonitoring(nextState: "idle")
                startMonitoring()
            }
            emitter.emitCommandResult(id: id, ok: true, state: state)
        case "shutdown":
            emitter.emitCommandResult(id: id, ok: true, state: "stopping")
            shutdown()
        default:
            emitter.emitCommandResult(
                id: id,
                ok: false,
                state: state,
                errorCode: "unsupported_command"
            )
        }
    }

    func protocolFailure(code: String) {
        emitter.emitError(code: code, recoverable: true)
    }

    func parentDisconnected() {
        shutdown()
    }

    private func startMonitoring() {
        guard state != "running" else {
            return
        }
        state = "running"
        workspaceMonitor.start()
        screenOCRMonitor.start()
        let permissions = permissionSnapshot(prompt: false)
        lastPermissionSnapshot = permissions
        if permissions.inputMonitoring {
            _ = inputMonitor.start()
        }
    }

    private func stopMonitoring(nextState: String) {
        workspaceMonitor.stop()
        accessibilityMonitor.detach()
        inputMonitor.stop()
        screenOCRMonitor.stop()
        activeApplication = nil
        activeCaptureAllowed = false
        state = nextState
    }

    private func shutdown() {
        stopMonitoring(nextState: "stopped")
        heartbeatTimer?.invalidate()
        heartbeatTimer = nil
        emitter.flushOutput()
        NSApplication.shared.terminate(nil)
    }

    private func emitHeartbeat() {
        let permissions = permissionSnapshot(prompt: false)
        if permissions != lastPermissionSnapshot {
            lastPermissionSnapshot = permissions
            emitter.emitPermissionStatus(permissions)
            if state == "running" {
                stopMonitoring(nextState: "idle")
                startMonitoring()
            }
        }
        emitter.emitHeartbeat(state: state, permissionSnapshot: permissions)
    }

    private func requestPermissions(id: String) {
        _ = permissionSnapshot(prompt: true)
        let browserBundleIdentifiers = NSWorkspace.shared.runningApplications
            .compactMap(\.bundleIdentifier)
            .filter { browserMetadataReader.supports(bundleIdentifier: $0) }
        Task.detached {
            for bundleIdentifier in browserBundleIdentifiers {
                _ = BrowserMetadataReader.automationAuthorization(
                    bundleIdentifier: bundleIdentifier,
                    prompt: true
                )
            }
            await MainActor.run { [weak self] in
                guard let self else {
                    return
                }
                let permissions = self.permissionSnapshot(prompt: false)
                let changed = permissions != self.lastPermissionSnapshot
                self.lastPermissionSnapshot = permissions
                self.emitter.emitPermissionStatus(permissions)
                if changed, self.state == "running" {
                    self.stopMonitoring(nextState: "idle")
                    self.startMonitoring()
                }
                self.emitter.emitCommandResult(id: id, ok: true, state: self.state)
            }
        }
    }

    private func handleForegroundApplication(_ application: NSRunningApplication) {
        guard state == "running",
              application.processIdentifier != ProcessInfo.processInfo.processIdentifier
        else {
            return
        }
        activeApplication = application
        targetGeneration += 1
        let appIdentifier = bounded(
            application.bundleIdentifier ?? "pid:\(application.processIdentifier)",
            limit: 256
        ) ?? "unknown"
        let appName = bounded(application.localizedName, limit: 256) ?? "Unknown Application"
        let normalizedAppIdentifier = appIdentifier.lowercased()
        if configuration.excludedBundleIdentifiers.contains(normalizedAppIdentifier) {
            blockCaptureForActiveApplication(application)
            lastHashes.removeValue(forKey: "workspace.foregroundChanged")
            emitAnonymousCoverageGap(
                sensor: "workspace",
                redaction: "user_excluded_application"
            )
            return
        }
        let baseDecision = PrivacyPolicy.decision(
            bundleIdentifier: appIdentifier,
            applicationName: appName,
            windowTitle: nil,
            focusedRole: nil,
            focusedSubrole: nil,
            configuredExclusions: configuration.excludedBundleIdentifiers
        )
        if !baseDecision.allowed {
            blockCaptureForActiveApplication(application)
            lastHashes.removeValue(forKey: "workspace.foregroundChanged")
            emitAnonymousCoverageGap(
                sensor: "workspace",
                redaction: baseDecision.redactions.first ?? "sensitive_application"
            )
            return
        }
        let browserSupported = browserMetadataReader.supports(
            bundleIdentifier: appIdentifier
        )
        let browserLike = browserMetadataReader.isBrowserLike(
            bundleIdentifier: appIdentifier,
            applicationName: appName
        )
        let browserPage = browserSupported
            ? browserMetadataReader.readForegroundPage(bundleIdentifier: appIdentifier)
            : nil
        let decision: CaptureDecision
        if browserPage?.privateWindow == true {
            decision = CaptureDecision(allowed: false, redactions: ["private_window"])
        } else if browserLike, browserPage == nil {
            decision = CaptureDecision(
                allowed: false,
                redactions: ["browser_privacy_state_unavailable"]
            )
        } else {
            decision = baseDecision
        }
        activeCaptureAllowed = decision.allowed
        inputMonitor.setCollectionEnabled(decision.allowed)
        emitDeduplicated(
            key: "workspace:\(appIdentifier):\(application.processIdentifier)",
            envelope: ObservationEnvelope(
                kind: "workspace.foregroundChanged",
                startedAtMs: epochMilliseconds(),
                endedAtMs: epochMilliseconds(),
                sensor: "workspace",
                appIdentifier: appIdentifier,
                appName: appName,
                opaqueWindowIdentifier: nil,
                reliability: "high",
                coverage: decision.allowed ? ["metadata"] : ["redacted"],
                redactions: decision.redactions,
                metadata: ["processId": Int(application.processIdentifier)],
                content: nil
            )
        )
        if browserPage?.privateWindow == true {
            emitBrowserBoundary(
                appIdentifier: appIdentifier,
                appName: appName,
                coverage: "redacted",
                redaction: "private_window",
                reliability: "high"
            )
        } else if browserLike, browserPage == nil {
            emitBrowserBoundary(
                appIdentifier: appIdentifier,
                appName: appName,
                coverage: "unavailable",
                redaction: "browser_privacy_state_unavailable",
                reliability: "low"
            )
        }
        if AXIsProcessTrusted(), decision.allowed {
            accessibilityMonitor.attach(to: application)
        } else {
            accessibilityMonitor.detach()
            screenOCRMonitor.updateTarget(
                ScreenCaptureTarget(
                    generation: targetGeneration,
                    processIdentifier: application.processIdentifier,
                    appIdentifier: appIdentifier,
                    appName: appName,
                    windowTitle: nil,
                    windowBounds: nil,
                    opaqueWindowIdentifier: nil,
                    captureAllowed: false,
                    accessibilityContentSufficient: false
                )
            )
        }
    }

    private func emitBrowserBoundary(
        appIdentifier: String,
        appName: String,
        coverage: String,
        redaction: String,
        reliability: String
    ) {
        let observedAtMs = epochMilliseconds()
        emitDeduplicated(
            key: "browser-boundary:\(appIdentifier):\(coverage):\(redaction)",
            envelope: ObservationEnvelope(
                kind: "browser.visiblePageChanged",
                startedAtMs: observedAtMs,
                endedAtMs: observedAtMs,
                sensor: "apple_events",
                appIdentifier: appIdentifier,
                appName: appName,
                opaqueWindowIdentifier: nil,
                reliability: reliability,
                coverage: [coverage],
                redactions: [redaction],
                metadata: [:],
                content: nil
            )
        )
    }

    private func handleAccessibilitySnapshot(_ snapshot: AccessibilitySnapshot) {
        guard state == "running",
              snapshot.processIdentifier == activeApplication?.processIdentifier
        else {
            return
        }
        let browserSupported = browserMetadataReader.supports(
            bundleIdentifier: snapshot.appIdentifier
        )
        let browserLike = browserMetadataReader.isBrowserLike(
            bundleIdentifier: snapshot.appIdentifier,
            applicationName: snapshot.appName
        )
        let browserPage = browserSupported
            ? browserMetadataReader.readForegroundPage(
                bundleIdentifier: snapshot.appIdentifier
            )
            : nil
        let baseDecision = PrivacyPolicy.decision(
            bundleIdentifier: snapshot.appIdentifier,
            applicationName: snapshot.appName,
            windowTitle: snapshot.windowTitle,
            focusedRole: snapshot.focusedRole,
            focusedSubrole: snapshot.focusedSubrole,
            focusedLabel: snapshot.focusedLabel,
            finalValue: snapshot.finalValue,
            visibleText: snapshot.visibleText,
            configuredExclusions: configuration.excludedBundleIdentifiers
        )
        let decision: CaptureDecision
        if browserPage?.privateWindow == true {
            decision = CaptureDecision(allowed: false, redactions: ["private_window"])
        } else if browserLike, browserPage == nil {
            decision = CaptureDecision(
                allowed: false,
                redactions: ["browser_privacy_state_unavailable"]
            )
        } else {
            decision = baseDecision
        }
        let observationKind = snapshot.notification
        let finalValueUnavailable = snapshot.finalValueAvailable == false
            && !snapshot.protectedInput
        accessibilityMonitor.applyCaptureDecision(
            allowed: decision.allowed,
            focusBaselineEstablished: observationKind == "ax.focusChanged"
        )
        activeCaptureAllowed = decision.allowed
        inputMonitor.setCollectionEnabled(decision.allowed)
        if !decision.allowed,
           decision.redactions.contains(where: {
               $0 != "browser_privacy_state_unavailable"
           })
        {
            screenOCRMonitor.updateTarget(
                blockedTarget(
                    application: activeApplication,
                    fallbackIdentifier: "redacted",
                    fallbackName: "Protected application"
                )
            )
            emitAnonymousCoverageGap(
                sensor: "ax",
                redaction: decision.redactions.first ?? "protected_content"
            )
            return
        }
        let contentAllowed = decision.allowed && configuration.captureContent
        var content: [String: Any] = [:]
        if contentAllowed {
            if let windowTitle = snapshot.windowTitle {
                content["windowTitle"] = windowTitle
            }
            if let focusedLabel = snapshot.focusedLabel {
                content["focusedLabel"] = focusedLabel
            }
            if let finalValue = snapshot.finalValue {
                content["finalValue"] = finalValue
                if observationKind == "ax.valueChanged" {
                    content["inputOrigin"] = "unknown"
                }
            }
            if let selectedText = snapshot.selectedText {
                content["selectedText"] = selectedText
            }
            if let visibleText = snapshot.visibleText {
                content["visibleText"] = visibleText
            }
        }
        var metadata: [String: Any] = [
            "processId": Int(snapshot.processIdentifier),
            "protectedInput": snapshot.protectedInput,
        ]
        if let role = snapshot.focusedRole {
            metadata["focusedRole"] = role
        }
        if let subrole = snapshot.focusedSubrole {
            metadata["focusedSubrole"] = subrole
        }
        if let opaqueControlIdentifier = snapshot.opaqueControlIdentifier {
            metadata["opaqueControlId"] = opaqueControlIdentifier
        }
        if let finalValueAvailable = snapshot.finalValueAvailable {
            metadata["finalValueAvailable"] = finalValueAvailable
        }
        var observationRedactions = decision.redactions
        if finalValueUnavailable,
           !observationRedactions.contains("final_value_unavailable")
        {
            observationRedactions.append("final_value_unavailable")
        }
        let coverage: [String]
        if decision.allowed && finalValueUnavailable {
            coverage = ["unavailable"]
        } else if contentAllowed && !content.isEmpty {
            coverage = ["content"]
        } else if decision.allowed {
            coverage = ["metadata"]
        } else {
            coverage = ["redacted"]
        }
        let dedupKey = "\(observationKind):\(snapshot.appIdentifier):"
            + "\(snapshot.opaqueWindowIdentifier ?? "none"):"
            + "\(snapshot.opaqueControlIdentifier ?? "none"):"
            + "\(snapshot.finalValueAvailable.map { $0 ? "true" : "false" } ?? "not_applicable"):"
            + "\(content)"
        let browserVisibleContentWillBeMerged = browserSupported
            && browserPage != nil
            && observationKind == "ax.visibleContentChanged"
        if !browserVisibleContentWillBeMerged {
            emitDeduplicated(
                key: dedupKey,
                envelope: ObservationEnvelope(
                    kind: observationKind,
                    startedAtMs: snapshot.observedAtMs,
                    endedAtMs: snapshot.observedAtMs,
                    sensor: "ax",
                    appIdentifier: snapshot.appIdentifier,
                    appName: snapshot.appName,
                    opaqueWindowIdentifier: snapshot.opaqueWindowIdentifier,
                    reliability: "high",
                    coverage: coverage,
                    redactions: observationRedactions,
                    metadata: metadata,
                    content: contentAllowed ? content : nil
                )
            )
        }

        let axSufficient = (snapshot.visibleText?.count ?? 0) >= 80
        screenOCRMonitor.updateTarget(
            ScreenCaptureTarget(
                generation: targetGeneration,
                processIdentifier: snapshot.processIdentifier,
                appIdentifier: snapshot.appIdentifier,
                appName: snapshot.appName,
                windowTitle: snapshot.windowTitle,
                windowBounds: snapshot.windowBounds,
                opaqueWindowIdentifier: snapshot.opaqueWindowIdentifier,
                captureAllowed: contentAllowed
                    && !snapshot.protectedInput
                    && CGPreflightScreenCaptureAccess(),
                accessibilityContentSufficient: axSufficient
            )
        )
        if browserPage?.privateWindow == true {
            emitBrowserPrivate(for: snapshot)
        } else if browserLike, browserPage == nil {
            emitBrowserUnavailable(for: snapshot)
        } else {
            readBrowserPage(for: snapshot, decision: decision, page: browserPage)
        }
    }

    private func emitBrowserPrivate(for snapshot: AccessibilitySnapshot) {
        emitDeduplicated(
            key: "browser-private:\(snapshot.appIdentifier):"
                + "\(snapshot.opaqueWindowIdentifier ?? "none")",
            envelope: ObservationEnvelope(
                kind: "browser.visiblePageChanged",
                startedAtMs: snapshot.observedAtMs,
                endedAtMs: snapshot.observedAtMs,
                sensor: "apple_events",
                appIdentifier: snapshot.appIdentifier,
                appName: snapshot.appName,
                opaqueWindowIdentifier: snapshot.opaqueWindowIdentifier,
                reliability: "high",
                coverage: ["redacted"],
                redactions: ["private_window"],
                metadata: [:],
                content: nil
            )
        )
    }

    private func emitBrowserUnavailable(for snapshot: AccessibilitySnapshot) {
        emitDeduplicated(
            key: "browser-unavailable:\(snapshot.appIdentifier):"
                + "\(snapshot.opaqueWindowIdentifier ?? "none")",
            envelope: ObservationEnvelope(
                kind: "browser.visiblePageChanged",
                startedAtMs: snapshot.observedAtMs,
                endedAtMs: snapshot.observedAtMs,
                sensor: "apple_events",
                appIdentifier: snapshot.appIdentifier,
                appName: snapshot.appName,
                opaqueWindowIdentifier: snapshot.opaqueWindowIdentifier,
                reliability: "low",
                coverage: ["unavailable"],
                redactions: ["browser_privacy_state_unavailable"],
                metadata: [:],
                content: nil
            )
        )
    }

    private func readBrowserPage(
        for snapshot: AccessibilitySnapshot,
        decision: CaptureDecision,
        page: BrowserPageSnapshot?
    ) {
        guard decision.allowed,
              configuration.captureContent,
              let page
        else {
            return
        }
        var content: [String: Any] = [
            "title": page.title,
            "url": page.sanitizedURL,
        ]
        if let visibleText = snapshot.visibleText {
            content["visibleText"] = visibleText
        }
        emitDeduplicated(
            key: "browser:\(snapshot.appIdentifier):\(page.sanitizedURL):"
                + "\(page.title):\(snapshot.visibleText ?? "")",
            envelope: ObservationEnvelope(
                kind: "browser.visiblePageChanged",
                startedAtMs: snapshot.observedAtMs,
                endedAtMs: snapshot.observedAtMs,
                sensor: "apple_events",
                appIdentifier: snapshot.appIdentifier,
                appName: snapshot.appName,
                opaqueWindowIdentifier: snapshot.opaqueWindowIdentifier,
                reliability: "high",
                coverage: ["content"],
                redactions: [],
                metadata: [:],
                content: content
            )
        )
    }

    private func handleOCRResult(_ result: OCRResult) {
        guard state == "running",
              result.target.generation == targetGeneration,
              result.target.processIdentifier == activeApplication?.processIdentifier
        else {
            return
        }
        let browserLike = browserMetadataReader.isBrowserLike(
            bundleIdentifier: result.target.appIdentifier,
            applicationName: result.target.appName
        )
        if browserLike {
            guard browserMetadataReader.supports(
                bundleIdentifier: result.target.appIdentifier
            ),
                let page = browserMetadataReader.readForegroundPage(
                    bundleIdentifier: result.target.appIdentifier
                ),
                !page.privateWindow
            else {
                emitAnonymousCoverageGap(
                    sensor: "ocr",
                    redaction: "browser_privacy_state_unavailable"
                )
                return
            }
        }
        let decision = PrivacyPolicy.decision(
            bundleIdentifier: result.target.appIdentifier,
            applicationName: result.target.appName,
            windowTitle: result.target.windowTitle,
            focusedRole: nil,
            focusedSubrole: nil,
            visibleText: result.text,
            configuredExclusions: configuration.excludedBundleIdentifiers
        )
        guard decision.allowed, configuration.captureContent else {
            return
        }
        emitDeduplicated(
            key: "ocr:\(result.target.appIdentifier):"
                + "\(result.target.opaqueWindowIdentifier ?? "none"):\(result.text)",
            envelope: ObservationEnvelope(
                kind: "screen.visibleTextChanged",
                startedAtMs: result.observedAtMs,
                endedAtMs: result.observedAtMs,
                sensor: "ocr",
                appIdentifier: result.target.appIdentifier,
                appName: result.target.appName,
                opaqueWindowIdentifier: result.target.opaqueWindowIdentifier,
                reliability: "medium",
                coverage: ["content"],
                redactions: [],
                metadata: ["languageHints": ["zh-Hans", "en-US"]],
                content: ["visibleText": result.text]
            )
        )
    }

    private func handleOCRGap(_ reason: String) {
        guard state == "running" else {
            return
        }
        emitAnonymousCoverageGap(sensor: "ocr", redaction: reason)
    }

    private func handleInputBucket(_ bucket: InputActivityBucket) {
        guard state == "running",
              let application = activeApplication,
              activeCaptureAllowed
        else {
            return
        }
        let appIdentifier = bounded(
            application.bundleIdentifier ?? "pid:\(application.processIdentifier)",
            limit: 256
        ) ?? "unknown"
        let appName = bounded(application.localizedName, limit: 256) ?? "Unknown Application"
        emitter.emitObservation(
            ObservationEnvelope(
                kind: "input.activityBucket",
                startedAtMs: bucket.startedAtMs,
                endedAtMs: bucket.endedAtMs,
                sensor: "cg_activity",
                appIdentifier: appIdentifier,
                appName: appName,
                opaqueWindowIdentifier: nil,
                reliability: "high",
                coverage: ["metadata"],
                redactions: ["key_values_not_collected", "pointer_coordinates_not_collected"],
                metadata: [
                    "keyCount": bucket.keyCount,
                    "clickCount": bucket.clickCount,
                    "scrollDelta": bucket.scrollDelta,
                    "mouseDistance": bucket.mouseDistance,
                ],
                content: nil
            )
        )
    }

    private func handleInputActivity() {
        guard state == "running", activeCaptureAllowed else {
            return
        }
        accessibilityMonitor.scheduleSnapshot(
            kind: "ax.visibleContentChanged",
            delay: 0.75
        )
        screenOCRMonitor.noteUserActivity()
    }

    private func handleClick(at point: CGPoint) {
        guard state == "running",
              let application = activeApplication,
              activeCaptureAllowed,
              let hit = accessibilityMonitor.hitTest(point: point)
        else {
            return
        }
        let appIdentifier = bounded(
            application.bundleIdentifier ?? "pid:\(application.processIdentifier)",
            limit: 256
        ) ?? "unknown"
        let appName = bounded(application.localizedName, limit: 256) ?? "Unknown Application"
        let clickDecision = PrivacyPolicy.decision(
            bundleIdentifier: appIdentifier,
            applicationName: appName,
            windowTitle: nil,
            focusedRole: hit.role,
            focusedSubrole: nil,
            focusedLabel: hit.label,
            configuredExclusions: configuration.excludedBundleIdentifiers
        )
        guard clickDecision.allowed else {
            emitAnonymousCoverageGap(
                sensor: "ax",
                redaction: clickDecision.redactions.first
                    ?? "sensitive_focused_control"
            )
            return
        }
        var metadata: [String: Any] = [:]
        if let role = hit.role {
            metadata["role"] = role
        }
        var content: [String: Any] = [:]
        if configuration.captureContent, let label = hit.label {
            content["label"] = label
        }
        emitter.emitObservation(
            ObservationEnvelope(
                kind: "ui.controlActivated",
                startedAtMs: epochMilliseconds(),
                endedAtMs: epochMilliseconds(),
                sensor: "ax",
                appIdentifier: appIdentifier,
                appName: appName,
                opaqueWindowIdentifier: nil,
                reliability: "medium",
                coverage: content.isEmpty ? ["metadata"] : ["content"],
                redactions: ["pointer_coordinates_not_collected"],
                metadata: metadata,
                content: content.isEmpty ? nil : content
            )
        )
    }

    private func emitDeduplicated(key: String, envelope: ObservationEnvelope) {
        var hasher = Hasher()
        hasher.combine(key)
        let hash = hasher.finalize()
        let identity = envelope.kind == "workspace.foregroundChanged"
            ? envelope.kind
            : "\(envelope.kind):\(envelope.appIdentifier)"
        if lastHashes[identity] == hash {
            return
        }
        lastHashes[identity] = hash
        emitter.emitObservation(envelope)
        if lastHashes.count > 512 {
            lastHashes.removeAll(keepingCapacity: true)
            lastHashes[identity] = hash
        }
    }

    private func blockCaptureForActiveApplication(
        _ application: NSRunningApplication
    ) {
        activeCaptureAllowed = false
        inputMonitor.setCollectionEnabled(false)
        accessibilityMonitor.detach()
        screenOCRMonitor.updateTarget(
            blockedTarget(
                application: application,
                fallbackIdentifier: "redacted",
                fallbackName: "Excluded application"
            )
        )
    }

    private func blockedTarget(
        application: NSRunningApplication?,
        fallbackIdentifier: String,
        fallbackName: String
    ) -> ScreenCaptureTarget {
        ScreenCaptureTarget(
            generation: targetGeneration,
            processIdentifier: application?.processIdentifier ?? -1,
            appIdentifier: fallbackIdentifier,
            appName: fallbackName,
            windowTitle: nil,
            windowBounds: nil,
            opaqueWindowIdentifier: nil,
            captureAllowed: false,
            accessibilityContentSufficient: false
        )
    }

    private func emitAnonymousCoverageGap(sensor: String, redaction: String) {
        let coverage: String
        if sensor == "workspace",
           ["user_excluded_application", "sensitive_application"].contains(redaction)
        {
            coverage = "redacted"
        } else if sensor == "ax",
                  Self.redactedCoverageGapReasons.contains(redaction)
        {
            coverage = "redacted"
        } else if sensor == "ocr",
                  Self.unavailableCoverageGapReasons.contains(redaction)
        {
            coverage = "unavailable"
        } else {
            emitter.emitError(code: "invalid_coverage_gap_reason", recoverable: true)
            return
        }
        let observedAtMs = epochMilliseconds()
        emitDeduplicated(
            key: "anonymous-gap:\(sensor):\(redaction)",
            envelope: ObservationEnvelope(
                kind: "coverage.gap",
                startedAtMs: observedAtMs,
                endedAtMs: observedAtMs,
                sensor: sensor,
                appIdentifier: "redacted",
                appName: "Protected application",
                opaqueWindowIdentifier: nil,
                reliability: "high",
                coverage: [coverage],
                redactions: [redaction],
                metadata: [:],
                content: nil
            )
        )
    }

    private func permissionSnapshot(prompt: Bool) -> PermissionSnapshot {
        let accessibility: Bool
        let screenRecording: Bool
        let inputMonitoring: Bool
        if prompt {
            accessibility = AXIsProcessTrustedWithOptions(
                ["AXTrustedCheckOptionPrompt": true] as CFDictionary
            )
            screenRecording = CGRequestScreenCaptureAccess()
            inputMonitoring = CGRequestListenEventAccess()
        } else {
            accessibility = AXIsProcessTrusted()
            screenRecording = CGPreflightScreenCaptureAccess()
            inputMonitoring = CGPreflightListenEventAccess()
        }
        return PermissionSnapshot(
            accessibility: accessibility,
            screenRecording: screenRecording,
            inputMonitoring: inputMonitoring,
            automation: automationPermissionSummary()
        )
    }

    private func automationPermissionSummary() -> String {
        let statuses = NSWorkspace.shared.runningApplications
            .compactMap(\.bundleIdentifier)
            .filter { browserMetadataReader.supports(bundleIdentifier: $0) }
            .map {
                BrowserMetadataReader.automationAuthorization(
                    bundleIdentifier: $0,
                    prompt: false
                )
            }
        if statuses.contains("denied") {
            return "denied"
        }
        if statuses.contains("not_determined") {
            return "not_determined"
        }
        if !statuses.isEmpty, statuses.allSatisfy({ $0 == "authorized" }) {
            return "authorized"
        }
        return "unavailable"
    }

    private func unsignedInteger(_ value: Any?) -> UInt64? {
        if let value = value as? UInt64 {
            return value
        }
        if let value = value as? NSNumber, value.int64Value >= 0 {
            return value.uint64Value
        }
        return nil
    }
}
