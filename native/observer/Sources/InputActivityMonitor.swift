import ApplicationServices
import CoreGraphics
import Foundation

func hasInputActivityAccess() -> Bool {
    AXIsProcessTrusted() || CGPreflightListenEventAccess()
}

struct InputActivityBucket {
    let generation: UInt64
    let startedAtMs: Int64
    let endedAtMs: Int64
    let keyCount: Int
    let clickCount: Int
    let scrollDelta: Double
    let mouseDistance: Double
}

struct InputActivityHealth: Equatable {
    let tapReady: Bool
    let lastCallbackAtMs: Int64?
    let lastBucketAtMs: Int64?

    var protocolFields: [String: Any] {
        var fields: [String: Any] = [
            "tapReady": tapReady,
            "lastCallbackAtMs": NSNull(),
            "lastBucketAtMs": NSNull(),
        ]
        if let lastCallbackAtMs {
            fields["lastCallbackAtMs"] = lastCallbackAtMs
        }
        if let lastBucketAtMs {
            fields["lastBucketAtMs"] = lastBucketAtMs
        }
        return fields
    }
}

final class InputTapStartupHandshake: @unchecked Sendable {
    private let lock = NSLock()
    private let semaphore = DispatchSemaphore(value: 0)
    private var result: Bool?

    func complete(ready: Bool) {
        lock.lock()
        guard result == nil else {
            lock.unlock()
            return
        }
        result = ready
        lock.unlock()
        semaphore.signal()
    }

    /// Returns nil only when the capture thread did not settle before the
    /// deadline. A false result is an explicit event-tap creation failure.
    func wait(timeout: DispatchTimeInterval) -> Bool? {
        lock.lock()
        let completed = result
        lock.unlock()
        if let completed {
            return completed
        }
        guard semaphore.wait(timeout: .now() + timeout) == .success else {
            return nil
        }
        lock.lock()
        let settled = result
        lock.unlock()
        return settled
    }
}

enum InputBucketTimerPolicy {
    static func accepts(
        callbackGeneration: UInt64,
        currentGeneration: UInt64,
        stopped: Bool,
        tapReady: Bool
    ) -> Bool {
        callbackGeneration == currentGeneration && !stopped && tapReady
    }
}

private final class InputAccumulator: @unchecked Sendable {
    private let lock = NSLock()
    private var keyCount = 0
    private var clickCount = 0
    private var scrollDelta = 0.0
    private var mouseDistance = 0.0
    private var enabled = false
    private var lastCallbackAtMs: Int64?
    private var lastBucketAtMs: Int64?

    func setEnabled(_ enabled: Bool) {
        lock.lock()
        self.enabled = enabled
        if !enabled {
            keyCount = 0
            clickCount = 0
            scrollDelta = 0
            mouseDistance = 0
        }
        lock.unlock()
    }

    func record(type: CGEventType, event: CGEvent, observedAtMs: Int64) -> CGPoint? {
        lock.lock()
        defer { lock.unlock() }
        lastCallbackAtMs = observedAtMs
        guard enabled else {
            return nil
        }
        switch type {
        case .keyDown:
            keyCount += 1
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            clickCount += 1
            return event.location
        case .scrollWheel:
            scrollDelta += event.getDoubleValueField(.scrollWheelEventPointDeltaAxis1)
        case .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged:
            let deltaX = event.getDoubleValueField(.mouseEventDeltaX)
            let deltaY = event.getDoubleValueField(.mouseEventDeltaY)
            mouseDistance += hypot(deltaX, deltaY)
        default:
            break
        }
        return nil
    }

    func markBucket(endedAtMs: Int64) {
        lock.lock()
        lastBucketAtMs = endedAtMs
        lock.unlock()
    }

    func resetHealth() {
        lock.lock()
        lastCallbackAtMs = nil
        lastBucketAtMs = nil
        lock.unlock()
    }

    func healthTimestamps() -> (lastCallbackAtMs: Int64?, lastBucketAtMs: Int64?) {
        lock.lock()
        defer { lock.unlock() }
        return (lastCallbackAtMs, lastBucketAtMs)
    }

    func drain() -> (keys: Int, clicks: Int, scroll: Double, distance: Double) {
        lock.lock()
        defer { lock.unlock() }
        let result = (keyCount, clickCount, scrollDelta, mouseDistance)
        keyCount = 0
        clickCount = 0
        scrollDelta = 0
        mouseDistance = 0
        return result
    }
}

final class InputActivityMonitor: @unchecked Sendable {
    typealias BucketHandler = @Sendable (InputActivityBucket) -> Void
    typealias ClickHandler = @Sendable (CGPoint) -> Void
    typealias ActivityHandler = @Sendable () -> Void
    typealias GapHandler = @Sendable (String) -> Void

    private let accumulator = InputAccumulator()
    private let onBucket: BucketHandler
    private let onClick: ClickHandler
    private let onActivity: ActivityHandler
    private let onGap: GapHandler
    private let stateLock = NSLock()
    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var captureThread: Thread?
    private var bucketTimer: DispatchSourceTimer?
    private var currentBucketStartMs: Int64 = 0
    private var stopped = true
    private var tapReady = false
    private var captureGeneration: UInt64 = 0
    private static let startupTimeout = DispatchTimeInterval.seconds(2)

    init(
        onBucket: @escaping BucketHandler,
        onClick: @escaping ClickHandler,
        onActivity: @escaping ActivityHandler,
        onGap: @escaping GapHandler
    ) {
        self.onBucket = onBucket
        self.onClick = onClick
        self.onActivity = onActivity
        self.onGap = onGap
    }

    func start() -> Bool {
        stateLock.lock()
        guard stopped else {
            let ready = tapReady
            stateLock.unlock()
            return ready
        }
        guard hasInputActivityAccess() else {
            stateLock.unlock()
            onGap("input_monitoring_unavailable")
            return false
        }
        stopped = false
        tapReady = false
        captureGeneration &+= 1
        let generation = captureGeneration
        let now = epochMilliseconds()
        currentBucketStartMs = (now / 5_000) * 5_000
        let startup = InputTapStartupHandshake()
        let thread = Thread { [weak self] in
            guard let self else {
                startup.complete(ready: false)
                return
            }
            self.runCaptureLoop(generation: generation, startup: startup)
        }
        thread.name = "WhaleHall Input Monitor"
        captureThread = thread
        stateLock.unlock()
        accumulator.resetHealth()
        thread.start()

        let startupResult = startup.wait(timeout: Self.startupTimeout)
        stateLock.lock()
        let ownsGeneration = captureGeneration == generation
        let ready = startupResult == true
            && ownsGeneration
            && !stopped
            && tapReady
        let tap = !ready && ownsGeneration ? eventTap : nil
        let source = !ready && ownsGeneration ? runLoopSource : nil
        if !ready, ownsGeneration {
            stopped = true
            tapReady = false
            captureGeneration &+= 1
            eventTap = nil
            runLoopSource = nil
            captureThread = nil
            accumulator.setEnabled(false)
        }
        stateLock.unlock()

        if let tap {
            CGEvent.tapEnable(tap: tap, enable: false)
        }
        if let source {
            CFRunLoopSourceInvalidate(source)
        }
        guard ready else {
            if startupResult == nil, ownsGeneration {
                onGap("input_event_tap_start_timeout")
            }
            return false
        }
        return startBucketTimer(generation: generation)
    }

    func healthSnapshot() -> InputActivityHealth {
        stateLock.lock()
        let ready = tapReady && !stopped
        stateLock.unlock()
        let timestamps = accumulator.healthTimestamps()
        return InputActivityHealth(
            tapReady: ready,
            lastCallbackAtMs: timestamps.lastCallbackAtMs,
            lastBucketAtMs: timestamps.lastBucketAtMs
        )
    }

    func owns(generation: UInt64) -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return InputBucketTimerPolicy.accepts(
            callbackGeneration: generation,
            currentGeneration: captureGeneration,
            stopped: stopped,
            tapReady: tapReady
        )
    }

    func setCollectionEnabled(_ enabled: Bool) {
        accumulator.setEnabled(enabled)
    }

    func stop() {
        stateLock.lock()
        stopped = true
        tapReady = false
        captureGeneration &+= 1
        let tap = eventTap
        let source = runLoopSource
        let timer = bucketTimer
        eventTap = nil
        runLoopSource = nil
        captureThread = nil
        bucketTimer = nil
        stateLock.unlock()

        timer?.cancel()
        if let tap {
            CGEvent.tapEnable(tap: tap, enable: false)
        }
        if let source {
            CFRunLoopSourceInvalidate(source)
        }
        _ = accumulator.drain()
        accumulator.setEnabled(false)
    }

    fileprivate func consume(type: CGEventType, event: CGEvent) {
        stateLock.lock()
        let acceptingCallbacks = tapReady && !stopped
        let generation = captureGeneration
        stateLock.unlock()
        guard acceptingCallbacks else {
            return
        }
        let clickPoint = accumulator.record(
            type: type,
            event: event,
            observedAtMs: epochMilliseconds()
        )
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            stateLock.lock()
            let tap = eventTap
            stateLock.unlock()
            var enabled = false
            if let tap, hasInputActivityAccess() {
                CGEvent.tapEnable(tap: tap, enable: true)
                enabled = CGEvent.tapIsEnabled(tap: tap)
            }
            stateLock.lock()
            let stillCurrent = captureGeneration == generation && !stopped
            if stillCurrent {
                tapReady = enabled
            }
            stateLock.unlock()
            if !enabled, stillCurrent {
                accumulator.setEnabled(false)
                onGap("input_event_tap_disabled")
            }
            return
        }
        onActivity()
        if let clickPoint {
            onClick(clickPoint)
        }
    }

    private func runCaptureLoop(
        generation: UInt64,
        startup: InputTapStartupHandshake
    ) {
        let observedTypes: [CGEventType] = [
            .keyDown,
            .leftMouseDown,
            .rightMouseDown,
            .otherMouseDown,
            .mouseMoved,
            .leftMouseDragged,
            .rightMouseDragged,
            .otherMouseDragged,
            .scrollWheel,
            .tapDisabledByTimeout,
            .tapDisabledByUserInput,
        ]
        let eventMask = observedTypes.reduce(CGEventMask(0)) { mask, eventType in
            mask | (CGEventMask(1) << eventType.rawValue)
        }
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: eventMask,
            callback: inputEventCallback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            stateLock.lock()
            let shouldReportFailure = captureGeneration == generation && !stopped
            if shouldReportFailure {
                stopped = true
                tapReady = false
                captureThread = nil
            }
            stateLock.unlock()
            startup.complete(ready: false)
            if shouldReportFailure {
                accumulator.setEnabled(false)
                onGap("input_monitoring_unavailable")
            }
            return
        }
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        stateLock.lock()
        let cancelled = stopped || captureGeneration != generation
        let enabled = CGEvent.tapIsEnabled(tap: tap)
        if cancelled || !enabled {
            stateLock.unlock()
            CGEvent.tapEnable(tap: tap, enable: false)
            CFRunLoopSourceInvalidate(source)
            startup.complete(ready: false)
            if !cancelled {
                onGap("input_monitoring_unavailable")
            }
            return
        }
        eventTap = tap
        runLoopSource = source
        tapReady = true
        stateLock.unlock()

        startup.complete(ready: true)
        CFRunLoopRun()

        stateLock.lock()
        let stoppedUnexpectedly = captureGeneration == generation && !stopped
        var timer: DispatchSourceTimer?
        if captureGeneration == generation {
            stopped = true
            tapReady = false
            eventTap = nil
            runLoopSource = nil
            captureThread = nil
            timer = bucketTimer
            bucketTimer = nil
        }
        stateLock.unlock()
        timer?.cancel()
        if stoppedUnexpectedly {
            accumulator.setEnabled(false)
            onGap("input_event_tap_disabled")
        }
    }

    private func startBucketTimer(generation: UInt64) -> Bool {
        let timer = DispatchSource.makeTimerSource(
            flags: [],
            queue: DispatchQueue(label: "com.seago.whalehall.observer.input-buckets")
        )
        let now = epochMilliseconds()
        let delayMs = 5_000 - (now % 5_000)
        timer.schedule(
            deadline: .now() + .milliseconds(Int(delayMs)),
            repeating: .seconds(5),
            leeway: .milliseconds(100)
        )
        timer.setEventHandler { [weak self] in
            self?.sealCompletedBucket(generation: generation)
        }
        timer.resume()
        stateLock.lock()
        guard captureGeneration == generation, !stopped, tapReady else {
            stateLock.unlock()
            timer.cancel()
            return false
        }
        bucketTimer = timer
        stateLock.unlock()
        return true
    }

    private func sealCompletedBucket(generation: UInt64) {
        stateLock.lock()
        guard InputBucketTimerPolicy.accepts(
            callbackGeneration: generation,
            currentGeneration: captureGeneration,
            stopped: stopped,
            tapReady: tapReady
        ) else {
            stateLock.unlock()
            return
        }
        let now = epochMilliseconds()
        let completedBoundary = (now / 5_000) * 5_000
        let startedAtMs = currentBucketStartMs
        currentBucketStartMs = completedBoundary
        let values = accumulator.drain()
        guard completedBoundary > startedAtMs,
              values.keys > 0
                || values.clicks > 0
                || abs(values.scroll) > 0.000_1
                || values.distance > 0.000_1
        else {
            stateLock.unlock()
            return
        }
        accumulator.markBucket(endedAtMs: completedBoundary)
        let bucket = InputActivityBucket(
            generation: generation,
            startedAtMs: startedAtMs,
            endedAtMs: completedBoundary,
            keyCount: values.keys,
            clickCount: values.clicks,
            scrollDelta: values.scroll,
            mouseDistance: values.distance
        )
        stateLock.unlock()
        onBucket(bucket)
    }
}

private func inputEventCallback(
    _: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    userInfo: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    guard let userInfo else {
        return Unmanaged.passUnretained(event)
    }
    let monitor = Unmanaged<InputActivityMonitor>.fromOpaque(userInfo).takeUnretainedValue()
    monitor.consume(type: type, event: event)
    return Unmanaged.passUnretained(event)
}
