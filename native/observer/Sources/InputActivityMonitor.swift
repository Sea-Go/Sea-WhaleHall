import ApplicationServices
import CoreGraphics
import Foundation

struct InputActivityBucket {
    let startedAtMs: Int64
    let endedAtMs: Int64
    let keyCount: Int
    let clickCount: Int
    let scrollDelta: Double
    let mouseDistance: Double
}

private final class InputAccumulator: @unchecked Sendable {
    private let lock = NSLock()
    private var keyCount = 0
    private var clickCount = 0
    private var scrollDelta = 0.0
    private var mouseDistance = 0.0
    private var enabled = false

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

    func record(type: CGEventType, event: CGEvent) -> CGPoint? {
        lock.lock()
        defer { lock.unlock() }
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
        defer { stateLock.unlock() }
        guard stopped else {
            return eventTap != nil
        }
        guard CGPreflightListenEventAccess() else {
            onGap("input_monitoring_unavailable")
            return false
        }
        stopped = false
        let now = epochMilliseconds()
        currentBucketStartMs = (now / 5_000) * 5_000
        let thread = Thread { [weak self] in
            self?.runCaptureLoop()
        }
        thread.name = "WhaleHall Input Monitor"
        captureThread = thread
        thread.start()
        startBucketTimer()
        return true
    }

    func setCollectionEnabled(_ enabled: Bool) {
        accumulator.setEnabled(enabled)
    }

    func stop() {
        stateLock.lock()
        stopped = true
        let tap = eventTap
        let source = runLoopSource
        eventTap = nil
        runLoopSource = nil
        stateLock.unlock()

        bucketTimer?.cancel()
        bucketTimer = nil
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
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            stateLock.lock()
            let tap = eventTap
            stateLock.unlock()
            if let tap, CGPreflightListenEventAccess() {
                CGEvent.tapEnable(tap: tap, enable: true)
            } else {
                accumulator.setEnabled(false)
                onGap("input_event_tap_disabled")
            }
            return
        }
        let clickPoint = accumulator.record(type: type, event: event)
        onActivity()
        if let clickPoint {
            onClick(clickPoint)
        }
    }

    private func runCaptureLoop() {
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
            stopped = true
            stateLock.unlock()
            accumulator.setEnabled(false)
            onGap("input_monitoring_unavailable")
            return
        }
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        stateLock.lock()
        if stopped {
            stateLock.unlock()
            return
        }
        eventTap = tap
        runLoopSource = source
        stateLock.unlock()

        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        CFRunLoopRun()
    }

    private func startBucketTimer() {
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
            self?.sealCompletedBucket()
        }
        bucketTimer = timer
        timer.resume()
    }

    private func sealCompletedBucket() {
        stateLock.lock()
        guard !stopped else {
            stateLock.unlock()
            return
        }
        let now = epochMilliseconds()
        let completedBoundary = (now / 5_000) * 5_000
        let startedAtMs = currentBucketStartMs
        currentBucketStartMs = completedBoundary
        stateLock.unlock()

        let values = accumulator.drain()
        guard completedBoundary > startedAtMs,
              values.keys > 0
                || values.clicks > 0
                || abs(values.scroll) > 0.000_1
                || values.distance > 0.000_1
        else {
            return
        }
        onBucket(
            InputActivityBucket(
                startedAtMs: startedAtMs,
                endedAtMs: completedBoundary,
                keyCount: values.keys,
                clickCount: values.clicks,
                scrollDelta: values.scroll,
                mouseDistance: values.distance
            )
        )
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
