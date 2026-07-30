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
    let opaqueControlIdentifier: String?
    let focusedRole: String?
    let focusedSubrole: String?
    let focusedLabel: String?
    let finalValue: String?
    let finalValueAvailable: Bool?
    let selectedText: String?
    let visibleText: String?
    let protectedInput: Bool
    let observedAtMs: Int64
}

enum AccessibilitySnapshotScheduleAction: Equatable {
    case schedule
    case ignore
    case flushThenSchedule
}

struct AccessibilityTextFlushPolicy {
    static let quietMilliseconds: Int64 = 2_000
    static let maximumMilliseconds: Int64 = 10_000

    static func action(
        pendingNotification: String,
        incomingNotification: String
    ) -> AccessibilitySnapshotScheduleAction {
        guard pendingNotification == "ax.valueChanged" else {
            return .schedule
        }
        if incomingNotification == "ax.valueChanged" {
            return .schedule
        }
        if incomingNotification == "ax.focusChanged" {
            return .flushThenSchedule
        }
        // Pointer movement, scrolling, safety refreshes, and window/title
        // notifications are not evidence of additional text editing. They
        // must not extend the two-second final-value silence window.
        return .ignore
    }

    static func delayMilliseconds(startedAtMs: Int64, nowMs: Int64) -> Int64 {
        let elapsedMs = max(0, nowMs - startedAtMs)
        return min(
            quietMilliseconds,
            max(0, maximumMilliseconds - elapsedMs)
        )
    }
}

enum AccessibilityCaptureGateState: Equatable {
    case awaitingFocusBaseline
    case allowed
    case blocked
}

enum AccessibilityCaptureGateEffect: Equatable {
    case preservePending
    case discardPending
}

struct AccessibilityCaptureGate {
    private(set) var state: AccessibilityCaptureGateState = .awaitingFocusBaseline

    var acceptsNonFocusSnapshots: Bool {
        state == .allowed
    }

    mutating func reset() {
        state = .awaitingFocusBaseline
    }

    mutating func beginFocusBaseline() -> AccessibilityCaptureGateEffect {
        state = .awaitingFocusBaseline
        return .discardPending
    }

    mutating func applyDecision(
        allowed: Bool,
        focusBaselineEstablished: Bool
    ) -> AccessibilityCaptureGateEffect {
        guard allowed else {
            state = .blocked
            return .discardPending
        }
        if state == .allowed || focusBaselineEstablished {
            state = .allowed
        }
        return .preservePending
    }
}

struct AccessibilityEditableCandidateDescriptor {
    let hidden: Bool
    let bounds: CGRect?
    let accessibilityFocused: Bool
    let systemFocused: Bool
}

struct AccessibilityEditableSelectionPolicy {
    static func isValidBounds(_ bounds: CGRect?) -> Bool {
        guard let bounds else {
            return false
        }
        return bounds.origin.x.isFinite
            && bounds.origin.y.isFinite
            && bounds.size.width.isFinite
            && bounds.size.height.isFinite
            && bounds.size.width > 0
            && bounds.size.height > 0
            && !bounds.isNull
            && !bounds.isInfinite
    }

    static func isVisible(
        _ candidate: AccessibilityEditableCandidateDescriptor,
        within windowBounds: CGRect?
    ) -> Bool {
        guard !candidate.hidden,
              isValidBounds(windowBounds),
              isValidBounds(candidate.bounds),
              let windowBounds,
              let candidateBounds = candidate.bounds
        else {
            return false
        }
        let intersection = candidateBounds.intersection(windowBounds)
        return !intersection.isNull && !intersection.isEmpty
    }

    static func selectedIndex(
        candidates: [AccessibilityEditableCandidateDescriptor],
        within windowBounds: CGRect?
    ) -> Int? {
        let visibleIndices = candidates.indices.filter {
            isVisible(candidates[$0], within: windowBounds)
        }
        let systemFocused = visibleIndices.filter {
            candidates[$0].systemFocused
        }
        if systemFocused.count == 1 {
            return systemFocused[0]
        }
        guard systemFocused.isEmpty else {
            return nil
        }

        let accessibilityFocused = visibleIndices.filter {
            candidates[$0].accessibilityFocused
        }
        if accessibilityFocused.count == 1 {
            return accessibilityFocused[0]
        }
        guard accessibilityFocused.isEmpty else {
            return nil
        }
        return visibleIndices.count == 1 ? visibleIndices[0] : nil
    }
}

private enum AccessibilityFinalValueRead {
    case available(String)
    case unavailable
}

private struct SendableAccessibilityElement: @unchecked Sendable {
    let value: AXUIElement
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
    private var pendingSourceElement: AXUIElement?
    private var valueBurstStartedAtMs: Int64?
    private var captureGate = AccessibilityCaptureGate()

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
        // The first focused editable control establishes the projector's text
        // baseline before any value-change notification can be interpreted.
        scheduleSnapshot(kind: "ax.focusChanged", delay: 0.15)
        safetyRefreshTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) {
            [weak self] _ in
            MainActor.assumeIsolated {
                self?.scheduleSnapshot(kind: "ax.visibleContentChanged", delay: 0)
            }
        }
    }

    func detach() {
        discardPendingSnapshot()
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
        captureGate.reset()
    }

    func applyCaptureDecision(
        allowed: Bool,
        focusBaselineEstablished: Bool
    ) {
        let effect = captureGate.applyDecision(
            allowed: allowed,
            focusBaselineEstablished: focusBaselineEstablished
        )
        if effect == .discardPending {
            // A denied/private context is sticky for AX final-value capture.
            // Destroy both the plaintext-bearing source reference and its
            // timer; only a later allowed focus baseline may reopen the gate.
            discardPendingSnapshot()
        }
    }

    func scheduleSnapshot(
        kind: String,
        delay: TimeInterval = 0.15,
        sourceElement: AXUIElement? = nil
    ) {
        if kind == "ax.focusChanged" {
            if AccessibilityTextFlushPolicy.action(
                pendingNotification: pendingNotification,
                incomingNotification: kind
            ) == .flushThenSchedule,
                captureGate.acceptsNonFocusSnapshots
            {
                captureSnapshot()
            }
            if captureGate.beginFocusBaseline() == .discardPending {
                discardPendingSnapshot()
            }
        } else {
            guard captureGate.acceptsNonFocusSnapshots else {
                return
            }
            if AccessibilityTextFlushPolicy.action(
                pendingNotification: pendingNotification,
                incomingNotification: kind
            ) == .ignore
            {
                return
            }
        }

        let nowMs = epochMilliseconds()
        if kind == "ax.valueChanged" {
            pendingNotification = kind
            valueBurstStartedAtMs = valueBurstStartedAtMs ?? nowMs
        } else {
            pendingNotification = kind
            valueBurstStartedAtMs = nil
        }
        if let sourceElement {
            pendingSourceElement = sourceElement
        }
        let effectiveDelay: TimeInterval
        if pendingNotification == "ax.valueChanged",
           let valueBurstStartedAtMs
        {
            effectiveDelay = TimeInterval(
                AccessibilityTextFlushPolicy.delayMilliseconds(
                    startedAtMs: valueBurstStartedAtMs,
                    nowMs: nowMs
                )
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

    private func discardPendingSnapshot() {
        snapshotTimer?.invalidate()
        snapshotTimer = nil
        pendingNotification = "ax.visibleContentChanged"
        pendingSourceElement = nil
        valueBurstStartedAtMs = nil
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

    fileprivate func received(notification: String, sourceElement: AXUIElement) {
        let kind: String
        switch notification {
        case kAXFocusedUIElementChangedNotification, kAXFocusedWindowChangedNotification:
            kind = "ax.focusChanged"
        case kAXValueChangedNotification, kAXSelectedTextChangedNotification:
            kind = "ax.valueChanged"
        default:
            kind = "ax.visibleContentChanged"
        }
        scheduleSnapshot(kind: kind, sourceElement: sourceElement)
    }

    private func captureSnapshot() {
        // A focus boundary may flush a pending value synchronously, before its
        // timer fires. Invalidate that timer up front so it cannot later reuse
        // a newly established focus baseline or a recovered privacy context.
        snapshotTimer?.invalidate()
        snapshotTimer = nil
        guard let application = runningApplication,
              let applicationElement,
              application.processIdentifier > 0
        else {
            return
        }
        let notification = pendingNotification
        let callbackSourceElement = pendingSourceElement
        let focusedWindow = attributeElement(applicationElement, kAXFocusedWindowAttribute)
        let windowBounds = focusedWindow.flatMap(elementBounds)
        let systemFocusedElement = attributeElement(
            applicationElement,
            kAXFocusedUIElementAttribute
        )
        let editableElement = resolveEditableElement(
            callbackSource: callbackSourceElement,
            systemFocusedElement: systemFocusedElement,
            focusedWindowBounds: windowBounds
        )
        let focusedElement = editableElement ?? systemFocusedElement
        updateObservedElements(
            window: focusedWindow,
            focusedElement: editableElement ?? systemFocusedElement
        )
        let root = focusedWindow ?? applicationElement
        let windowTitle = focusedWindow.flatMap { attributeString($0, kAXTitleAttribute) }
        let focusedRole = focusedElement.flatMap { attributeString($0, kAXRoleAttribute) }
        let focusedSubrole = focusedElement.flatMap { attributeString($0, kAXSubroleAttribute) }
        let protectedInput = focusedElement.map(PrivacyPolicy.isProtected(element:)) ?? false
        let editableValueExpected = notification == "ax.valueChanged"
            || [callbackSourceElement, systemFocusedElement]
                .compactMap { $0 }
                .contains {
                    isEditable($0) || isEditableContainer($0)
                }
        let focusedLabel: String?
        let finalValue: String?
        let finalValueAvailable: Bool?
        let selectedText: String?
        if protectedInput {
            focusedLabel = nil
            finalValue = nil
            finalValueAvailable = nil
            selectedText = nil
        } else {
            focusedLabel = focusedElement.flatMap {
                attributeString($0, kAXTitleAttribute)
                    ?? attributeString($0, kAXDescriptionAttribute)
                    ?? attributeString($0, kAXHelpAttribute)
            }
            if let editableElement {
                switch readFinalValue(editableElement) {
                case let .available(value):
                    finalValue = value
                    finalValueAvailable = true
                case .unavailable:
                    finalValue = nil
                    finalValueAvailable = false
                }
            } else {
                finalValue = nil
                finalValueAvailable = editableValueExpected ? false : nil
            }
            selectedText = editableElement.flatMap {
                attributeString($0, kAXSelectedTextAttribute)
            }
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
        let controlIdentifier: String?
        if let editableElement {
            controlIdentifier = opaqueControlIdentifier(
                for: editableElement,
                appIdentifier: appIdentifier,
                fallbackProcessIdentifier: application.processIdentifier
            )
        } else {
            controlIdentifier = nil
        }
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
            notification: notification,
            windowTitle: bounded(windowTitle, limit: 2_048),
            windowBounds: windowBounds,
            opaqueWindowIdentifier: opaqueWindowIdentifier,
            opaqueControlIdentifier: controlIdentifier,
            focusedRole: bounded(focusedRole, limit: 128),
            focusedSubrole: bounded(focusedSubrole, limit: 128),
            focusedLabel: bounded(focusedLabel, limit: 1_024),
            finalValue: finalValue,
            finalValueAvailable: finalValueAvailable,
            selectedText: bounded(selectedText, limit: 4_096),
            visibleText: bounded(visibleText, limit: 16_384),
            protectedInput: protectedInput,
            observedAtMs: epochMilliseconds()
        )
        if notification == "ax.valueChanged" {
            valueBurstStartedAtMs = nil
        }
        pendingNotification = "ax.visibleContentChanged"
        pendingSourceElement = nil
        onSnapshot(snapshot)
    }

    private func resolveEditableElement(
        callbackSource: AXUIElement?,
        systemFocusedElement: AXUIElement?,
        focusedWindowBounds: CGRect?
    ) -> AXUIElement? {
        guard AccessibilityEditableSelectionPolicy.isValidBounds(
            focusedWindowBounds
        ) else {
            return nil
        }
        if let callbackSource,
           !isEditableContainer(callbackSource),
           isVisibleEditable(
                callbackSource,
                within: focusedWindowBounds,
                systemFocusedElement: systemFocusedElement
           )
        {
            return callbackSource
        }
        if let systemFocusedElement,
           !isEditableContainer(systemFocusedElement),
           isVisibleEditable(
                systemFocusedElement,
                within: focusedWindowBounds,
                systemFocusedElement: systemFocusedElement
           )
        {
            return systemFocusedElement
        }

        var containers: [AXUIElement] = []
        for element in [callbackSource, systemFocusedElement].compactMap({ $0 })
        where isEditableContainer(element)
        {
            if !containers.contains(where: { CFEqual($0, element) }) {
                containers.append(element)
            }
        }
        for container in containers {
            if let descendant = editableDescendant(
                of: container,
                systemFocusedElement: systemFocusedElement,
                focusedWindowBounds: focusedWindowBounds
            ) {
                return descendant
            }
        }
        return nil
    }

    private func editableDescendant(
        of root: AXUIElement,
        systemFocusedElement: AXUIElement?,
        focusedWindowBounds: CGRect?
    ) -> AXUIElement? {
        guard attributeBool(root, kAXHiddenAttribute) != true else {
            return nil
        }
        var queue = childElements(of: root)
        var index = 0
        var visited = Set<CFHashCode>()
        var candidates: [(
            element: AXUIElement,
            descriptor: AccessibilityEditableCandidateDescriptor
        )] = []

        while index < queue.count, visited.count < 160 {
            let element = queue[index]
            index += 1
            let elementHash = CFHash(element)
            guard visited.insert(elementHash).inserted else {
                continue
            }
            if attributeBool(element, kAXHiddenAttribute) == true {
                continue
            }
            if isEditable(element) {
                candidates.append((
                    element: element,
                    descriptor: editableCandidateDescriptor(
                        for: element,
                        systemFocusedElement: systemFocusedElement
                    )
                ))
            }
            queue.append(contentsOf: childElements(of: element))
        }
        let descriptors = candidates.map(\.descriptor)
        guard let selectedIndex = AccessibilityEditableSelectionPolicy.selectedIndex(
            candidates: descriptors,
            within: focusedWindowBounds
        )
        else {
            return nil
        }
        return candidates[selectedIndex].element
    }

    private func childElements(of element: AXUIElement) -> [AXUIElement] {
        let visibleChildren = attributeElements(element, kAXVisibleChildrenAttribute)
        let allChildren = attributeElements(element, kAXChildrenAttribute)
        guard !visibleChildren.isEmpty else {
            return allChildren
        }
        return visibleChildren + allChildren.filter { child in
            !visibleChildren.contains(where: { CFEqual($0, child) })
        }
    }

    private func isEditableContainer(_ element: AXUIElement) -> Bool {
        let role = attributeString(element, kAXRoleAttribute)?.lowercased() ?? ""
        return role == "axwebarea" || role == "axgroup"
    }

    private func isEditable(_ element: AXUIElement) -> Bool {
        let role = attributeString(element, kAXRoleAttribute)?.lowercased() ?? ""
        let subrole = attributeString(element, kAXSubroleAttribute)?.lowercased() ?? ""
        if role == "axtextfield"
            || role == "axtextarea"
            || role == "axcombobox"
            || role == "axsearchfield"
            || subrole.contains("searchfield")
            || subrole.contains("securetextfield")
        {
            return true
        }
        return false
    }

    private func isVisibleEditable(
        _ element: AXUIElement,
        within focusedWindowBounds: CGRect?,
        systemFocusedElement: AXUIElement?
    ) -> Bool {
        isEditable(element)
            && AccessibilityEditableSelectionPolicy.isVisible(
                editableCandidateDescriptor(
                    for: element,
                    systemFocusedElement: systemFocusedElement
                ),
                within: focusedWindowBounds
            )
    }

    private func editableCandidateDescriptor(
        for element: AXUIElement,
        systemFocusedElement: AXUIElement?
    ) -> AccessibilityEditableCandidateDescriptor {
        AccessibilityEditableCandidateDescriptor(
            hidden: attributeBool(element, kAXHiddenAttribute) == true,
            bounds: elementBounds(element),
            accessibilityFocused:
                attributeBool(element, kAXFocusedAttribute) == true,
            systemFocused:
                systemFocusedElement.map({ CFEqual(element, $0) }) == true
        )
    }

    private func elementBounds(_ element: AXUIElement) -> CGRect? {
        guard let point = attributePoint(element, kAXPositionAttribute),
              let size = attributeSize(element, kAXSizeAttribute)
        else {
            return nil
        }
        let bounds = CGRect(origin: point, size: size)
        return AccessibilityEditableSelectionPolicy.isValidBounds(bounds)
            ? bounds
            : nil
    }

    private func readFinalValue(_ element: AXUIElement) -> AccessibilityFinalValueRead {
        var rawValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            element,
            kAXValueAttribute as CFString,
            &rawValue
        ) == .success,
            let rawValue
        else {
            return .unavailable
        }
        let value: String
        if let text = rawValue as? String {
            value = text
        } else if let text = rawValue as? NSAttributedString {
            value = text.string
        } else if let number = rawValue as? NSNumber {
            value = number.stringValue
        } else {
            return .unavailable
        }
        // Empty and whitespace-only strings are valid final values: they are
        // required to represent a user deleting all text. Only NUL is removed.
        return .available(
            String(
                value
                    .replacingOccurrences(of: "\u{0000}", with: "")
                    .prefix(4_096)
            )
        )
    }

    private func opaqueControlIdentifier(
        for element: AXUIElement,
        appIdentifier: String,
        fallbackProcessIdentifier: pid_t
    ) -> String {
        var processIdentifier = fallbackProcessIdentifier
        _ = AXUIElementGetPid(element, &processIdentifier)
        let role = attributeString(element, kAXRoleAttribute) ?? "unknown"
        let subrole = attributeString(element, kAXSubroleAttribute) ?? "none"
        return opaqueIdentifier(
            [
                "control-v1",
                appIdentifier,
                String(processIdentifier),
                role,
                subrole,
                String(CFHash(element)),
            ],
            prefix: "oc1"
        )
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
    sourceElement: AXUIElement,
    notification: CFString,
    refcon: UnsafeMutableRawPointer?
) {
    guard let refcon else {
        return
    }
    let monitor = Unmanaged<AccessibilityMonitor>.fromOpaque(refcon).takeUnretainedValue()
    let notificationName = notification as String
    let source = SendableAccessibilityElement(value: sourceElement)
    // The observer source is installed on the main run loop, so the callback
    // is main-actor isolated in practice. Keeping the AX source element is
    // necessary for Electron/WebArea notifications whose application-level
    // focused element is only a container.
    MainActor.assumeIsolated {
        monitor.received(
            notification: notificationName,
            sourceElement: source.value
        )
    }
}
