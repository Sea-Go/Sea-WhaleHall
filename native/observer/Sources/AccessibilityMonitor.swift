import AppKit
import ApplicationServices
import Foundation

struct AccessibilitySnapshot {
    let processIdentifier: pid_t
    let appIdentifier: String
    let appName: String
    let notification: String
    let windowTitle: String?
    let windowBounds: CGRect?
    let opaqueWindowIdentifier: String?
    let focusedRole: String?
    let focusedSubrole: String?
    let focusedLabel: String?
    let finalValue: String?
    let selectedText: String?
    let visibleText: String?
    let protectedInput: Bool
    let observedAtMs: Int64
}

@MainActor
final class AccessibilityMonitor {
    typealias SnapshotHandler = @MainActor (AccessibilitySnapshot) -> Void

    private let onSnapshot: SnapshotHandler
    private var observer: AXObserver?
    private var applicationElement: AXUIElement?
    private var runningApplication: NSRunningApplication?
    private var pendingNotification = "ax.visibleContentChanged"
    private var snapshotTimer: Timer?
    private var safetyRefreshTimer: Timer?
    private var observedWindow: AXUIElement?
    private var observedFocusedElement: AXUIElement?
    private var valueBurstStartedAtMs: Int64?

    private let valueBurstQuietMs: Int64 = 2_000
    private let valueBurstMaximumMs: Int64 = 10_000

    init(onSnapshot: @escaping SnapshotHandler) {
        self.onSnapshot = onSnapshot
    }

    func attach(to application: NSRunningApplication) {
        detach()
        runningApplication = application
        let processIdentifier = application.processIdentifier
        guard processIdentifier > 0 else {
            return
        }

        var createdObserver: AXObserver?
        let error = AXObserverCreate(
            processIdentifier,
            accessibilityObserverCallback,
            &createdObserver
        )
        guard error == .success, let createdObserver else {
            return
        }

        let appElement = AXUIElementCreateApplication(processIdentifier)
        observer = createdObserver
        applicationElement = appElement
        let opaqueSelf = Unmanaged.passUnretained(self).toOpaque()
        let notifications = [
            kAXFocusedUIElementChangedNotification,
            kAXFocusedWindowChangedNotification,
            kAXValueChangedNotification,
            kAXSelectedTextChangedNotification,
            kAXTitleChangedNotification,
            kAXWindowCreatedNotification,
        ]
        for notification in notifications {
            _ = AXObserverAddNotification(
                createdObserver,
                appElement,
                notification as CFString,
                opaqueSelf
            )
        }
        CFRunLoopAddSource(
            CFRunLoopGetMain(),
            AXObserverGetRunLoopSource(createdObserver),
            .commonModes
        )
        scheduleSnapshot(kind: "ax.visibleContentChanged", delay: 0.15)
        safetyRefreshTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) {
            [weak self] _ in
            MainActor.assumeIsolated {
                self?.scheduleSnapshot(kind: "ax.visibleContentChanged", delay: 0)
            }
        }
    }

    func detach() {
        snapshotTimer?.invalidate()
        snapshotTimer = nil
        safetyRefreshTimer?.invalidate()
        safetyRefreshTimer = nil
        if let observer {
            CFRunLoopRemoveSource(
                CFRunLoopGetMain(),
                AXObserverGetRunLoopSource(observer),
                .commonModes
            )
        }
        observer = nil
        applicationElement = nil
        runningApplication = nil
        observedWindow = nil
        observedFocusedElement = nil
        valueBurstStartedAtMs = nil
    }

    func scheduleSnapshot(kind: String, delay: TimeInterval = 0.15) {
        let nowMs = epochMilliseconds()
        if kind == "ax.valueChanged" {
            pendingNotification = kind
            valueBurstStartedAtMs = valueBurstStartedAtMs ?? nowMs
        } else if pendingNotification != "ax.valueChanged" {
            pendingNotification = kind
        }
        let effectiveDelay: TimeInterval
        if pendingNotification == "ax.valueChanged",
           let valueBurstStartedAtMs
        {
            let elapsedMs = max(0, nowMs - valueBurstStartedAtMs)
            let forceRemainingMs = max(0, valueBurstMaximumMs - elapsedMs)
            effectiveDelay = TimeInterval(
                min(valueBurstQuietMs, forceRemainingMs)
            ) / 1_000
        } else {
            effectiveDelay = delay
        }
        snapshotTimer?.invalidate()
        snapshotTimer = Timer.scheduledTimer(
            withTimeInterval: effectiveDelay,
            repeats: false
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.captureSnapshot()
            }
        }
    }

    func hitTest(point: CGPoint) -> (role: String?, label: String?)? {
        let systemWide = AXUIElementCreateSystemWide()
        var element: AXUIElement?
        guard AXUIElementCopyElementAtPosition(
            systemWide,
            Float(point.x),
            Float(point.y),
            &element
        ) == .success,
            let element,
            !PrivacyPolicy.isProtected(element: element)
        else {
            return nil
        }
        let role = attributeString(element, kAXRoleAttribute)
        let label = attributeString(element, kAXTitleAttribute)
            ?? attributeString(element, kAXDescriptionAttribute)
            ?? attributeString(element, kAXHelpAttribute)
        return (bounded(role, limit: 128), bounded(label, limit: 1_024))
    }

    fileprivate func received(notification: String) {
        let kind: String
        switch notification {
        case kAXFocusedUIElementChangedNotification, kAXFocusedWindowChangedNotification:
            kind = "ax.focusChanged"
        case kAXValueChangedNotification, kAXSelectedTextChangedNotification:
            kind = "ax.valueChanged"
        default:
            kind = "ax.visibleContentChanged"
        }
        scheduleSnapshot(kind: kind)
    }

    private func captureSnapshot() {
        guard let application = runningApplication,
              let applicationElement,
              application.processIdentifier > 0
        else {
            return
        }
        let focusedWindow = attributeElement(applicationElement, kAXFocusedWindowAttribute)
        let focusedElement = attributeElement(applicationElement, kAXFocusedUIElementAttribute)
        updateObservedElements(window: focusedWindow, focusedElement: focusedElement)
        let root = focusedWindow ?? applicationElement
        let windowTitle = focusedWindow.flatMap { attributeString($0, kAXTitleAttribute) }
        let focusedRole = focusedElement.flatMap { attributeString($0, kAXRoleAttribute) }
        let focusedSubrole = focusedElement.flatMap { attributeString($0, kAXSubroleAttribute) }
        let protectedInput = focusedElement.map(PrivacyPolicy.isProtected(element:)) ?? false
        let focusedLabel: String?
        let finalValue: String?
        let selectedText: String?
        if protectedInput {
            focusedLabel = nil
            finalValue = nil
            selectedText = nil
        } else {
            focusedLabel = focusedElement.flatMap {
                attributeString($0, kAXTitleAttribute)
                    ?? attributeString($0, kAXDescriptionAttribute)
                    ?? attributeString($0, kAXHelpAttribute)
            }
            finalValue = focusedElement.flatMap { attributeString($0, kAXValueAttribute) }
            selectedText = focusedElement.flatMap {
                attributeString($0, kAXSelectedTextAttribute)
            }
        }

        let windowBounds: CGRect?
        if let focusedWindow,
           let point = attributePoint(focusedWindow, kAXPositionAttribute),
           let size = attributeSize(focusedWindow, kAXSizeAttribute),
           size.width > 0,
           size.height > 0
        {
            windowBounds = CGRect(origin: point, size: size)
        } else {
            windowBounds = nil
        }
        // AX trees can contain off-screen editor buffers and collapsed/hidden
        // descendants. Text is only eligible when the element exposes geometry
        // intersecting the currently focused window. If that window cannot be
        // bounded, fail closed and let the foreground-window OCR path provide
        // visible-only coverage instead.
        let visibleText = protectedInput
            ? nil
            : collectVisibleText(root: root, within: windowBounds)
        let appIdentifier = application.bundleIdentifier
            ?? "pid:\(application.processIdentifier)"
        let appName = application.localizedName ?? "Unknown Application"
        let opaqueWindowIdentifier = windowBounds.map {
            opaqueIdentifier([
                appIdentifier,
                String(Int($0.origin.x.rounded())),
                String(Int($0.origin.y.rounded())),
                String(Int($0.width.rounded())),
                String(Int($0.height.rounded())),
            ])
        }
        let snapshot = AccessibilitySnapshot(
            processIdentifier: application.processIdentifier,
            appIdentifier: bounded(appIdentifier, limit: 256) ?? "unknown",
            appName: bounded(appName, limit: 256) ?? "Unknown Application",
            notification: pendingNotification,
            windowTitle: bounded(windowTitle, limit: 2_048),
            windowBounds: windowBounds,
            opaqueWindowIdentifier: opaqueWindowIdentifier,
            focusedRole: bounded(focusedRole, limit: 128),
            focusedSubrole: bounded(focusedSubrole, limit: 128),
            focusedLabel: bounded(focusedLabel, limit: 1_024),
            finalValue: bounded(finalValue, limit: 4_096),
            selectedText: bounded(selectedText, limit: 4_096),
            visibleText: bounded(visibleText, limit: 16_384),
            protectedInput: protectedInput,
            observedAtMs: epochMilliseconds()
        )
        if pendingNotification == "ax.valueChanged" {
            valueBurstStartedAtMs = nil
        }
        pendingNotification = "ax.visibleContentChanged"
        onSnapshot(snapshot)
    }

    private func updateObservedElements(
        window: AXUIElement?,
        focusedElement: AXUIElement?
    ) {
        guard let observer else {
            return
        }
        if let observedWindow {
            for notification in [
                kAXTitleChangedNotification,
                kAXMovedNotification,
                kAXResizedNotification,
                kAXUIElementDestroyedNotification,
            ] {
                _ = AXObserverRemoveNotification(
                    observer,
                    observedWindow,
                    notification as CFString
                )
            }
        }
        if let observedFocusedElement {
            for notification in [
                kAXValueChangedNotification,
                kAXSelectedTextChangedNotification,
                kAXTitleChangedNotification,
                kAXUIElementDestroyedNotification,
            ] {
                _ = AXObserverRemoveNotification(
                    observer,
                    observedFocusedElement,
                    notification as CFString
                )
            }
        }

        observedWindow = window
        observedFocusedElement = focusedElement
        if let window {
            for notification in [
                kAXTitleChangedNotification,
                kAXMovedNotification,
                kAXResizedNotification,
                kAXUIElementDestroyedNotification,
            ] {
                _ = AXObserverAddNotification(
                    observer,
                    window,
                    notification as CFString,
                    Unmanaged.passUnretained(self).toOpaque()
                )
            }
        }
        if let focusedElement {
            for notification in [
                kAXValueChangedNotification,
                kAXSelectedTextChangedNotification,
                kAXTitleChangedNotification,
                kAXUIElementDestroyedNotification,
            ] {
                _ = AXObserverAddNotification(
                    observer,
                    focusedElement,
                    notification as CFString,
                    Unmanaged.passUnretained(self).toOpaque()
                )
            }
        }
    }

    private func collectVisibleText(
        root: AXUIElement,
        within focusedWindowBounds: CGRect?
    ) -> String? {
        guard let focusedWindowBounds,
              !focusedWindowBounds.isEmpty,
              !focusedWindowBounds.isNull
        else {
            return nil
        }
        var queue = [root]
        var index = 0
        var visitedNodes = 0
        var pieces: [String] = []
        var characterCount = 0

        while index < queue.count, visitedNodes < 300, characterCount < 16_384 {
            let element = queue[index]
            index += 1
            visitedNodes += 1
            if PrivacyPolicy.isProtected(element: element) {
                continue
            }
            if attributeBool(element, kAXHiddenAttribute) == true {
                continue
            }

            let role = attributeString(element, kAXRoleAttribute)?.lowercased() ?? ""
            if let position = attributePoint(element, kAXPositionAttribute),
               let size = attributeSize(element, kAXSizeAttribute),
               size.width > 0,
               size.height > 0
            {
                let elementBounds = CGRect(origin: position, size: size)
                let visibleIntersection = elementBounds.intersection(focusedWindowBounds)
                if !visibleIntersection.isNull, !visibleIntersection.isEmpty {
                    let candidates = [
                        attributeString(element, kAXTitleAttribute),
                        attributeString(element, kAXDescriptionAttribute),
                        attributeString(element, kAXValueAttribute),
                        attributeString(element, kAXSelectedTextAttribute),
                    ]
                    for candidate in candidates {
                        guard let candidate,
                              !candidate.isEmpty,
                              !pieces.contains(candidate)
                        else {
                            continue
                        }
                        if role.contains("image") && candidate.count > 1_024 {
                            continue
                        }
                        let remaining = 16_384 - characterCount
                        let value = String(candidate.prefix(remaining))
                        pieces.append(value)
                        characterCount += value.count + 1
                        if characterCount >= 16_384 {
                            break
                        }
                    }
                }
            }
            let visibleChildren = attributeElements(
                element,
                kAXVisibleChildrenAttribute
            )
            queue.append(contentsOf: visibleChildren.isEmpty
                ? attributeElements(element, kAXChildrenAttribute)
                : visibleChildren)
        }
        return pieces.isEmpty ? nil : pieces.joined(separator: "\n")
    }
}

private func accessibilityObserverCallback(
    _: AXObserver,
    _: AXUIElement,
    notification: CFString,
    refcon: UnsafeMutableRawPointer?
) {
    guard let refcon else {
        return
    }
    let monitor = Unmanaged<AccessibilityMonitor>.fromOpaque(refcon).takeUnretainedValue()
    let notificationName = notification as String
    Task { @MainActor in
        monitor.received(notification: notificationName)
    }
}
