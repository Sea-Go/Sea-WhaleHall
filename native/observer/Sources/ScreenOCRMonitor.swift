import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit
import Vision

struct ScreenCaptureTarget {
    let generation: UInt64
    let processIdentifier: pid_t
    let appIdentifier: String
    let appName: String
    let windowTitle: String?
    let windowBounds: CGRect?
    let opaqueWindowIdentifier: String?
    let captureAllowed: Bool
    let accessibilityContentSufficient: Bool
}

struct OCRResult {
    let target: ScreenCaptureTarget
    let text: String
    let observedAtMs: Int64
}

@MainActor
final class ScreenOCRMonitor {
    typealias ResultHandler = @MainActor (OCRResult) -> Void
    typealias GapHandler = @MainActor (String) -> Void

    private let onResult: ResultHandler
    private let onGap: GapHandler
    private var target: ScreenCaptureTarget?
    private var captureTimer: Timer?
    private var refreshTimer: Timer?
    private var lastCaptureStartedAtMs: Int64 = 0
    private var previousPixels: [UInt8]?
    private var captureInFlight = false
    private var pendingCapture = false

    init(onResult: @escaping ResultHandler, onGap: @escaping GapHandler) {
        self.onResult = onResult
        self.onGap = onGap
    }

    func start() {
        refreshTimer?.invalidate()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) {
            [weak self] _ in
            MainActor.assumeIsolated {
                self?.scheduleCapture(after: 0, reason: "safety_refresh")
            }
        }
    }

    func stop() {
        captureTimer?.invalidate()
        refreshTimer?.invalidate()
        captureTimer = nil
        refreshTimer = nil
        target = nil
        previousPixels = nil
        pendingCapture = false
    }

    func updateTarget(_ newTarget: ScreenCaptureTarget) {
        let changedWindow = target?.opaqueWindowIdentifier != newTarget.opaqueWindowIdentifier
            || target?.processIdentifier != newTarget.processIdentifier
        target = newTarget
        if changedWindow {
            previousPixels = nil
        }
        guard newTarget.captureAllowed,
              !newTarget.accessibilityContentSufficient
        else {
            captureTimer?.invalidate()
            captureTimer = nil
            return
        }
        scheduleCapture(after: 0.3, reason: "target_changed")
    }

    func noteUserActivity() {
        guard target?.captureAllowed == true,
              target?.accessibilityContentSufficient == false
        else {
            return
        }
        scheduleCapture(after: 0.75, reason: "input_quiet")
    }

    private func scheduleCapture(after requestedDelay: TimeInterval, reason _: String) {
        guard target?.captureAllowed == true,
              target?.accessibilityContentSufficient == false
        else {
            return
        }
        if ProcessInfo.processInfo.thermalState == .critical {
            onGap("thermal_critical")
            return
        }
        let minimumIntervalMs: Int64 = ProcessInfo.processInfo.thermalState == .serious
            ? 10_000
            : 2_000
        let elapsedMs = epochMilliseconds() - lastCaptureStartedAtMs
        let throttleDelay = max(
            0,
            TimeInterval(minimumIntervalMs - max(0, elapsedMs)) / 1_000
        )
        let delay = max(requestedDelay, throttleDelay)
        captureTimer?.invalidate()
        captureTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) {
            [weak self] _ in
            MainActor.assumeIsolated {
                self?.beginCapture()
            }
        }
    }

    private func beginCapture() {
        guard let target,
              target.captureAllowed,
              !target.accessibilityContentSufficient,
              CGPreflightScreenCaptureAccess()
        else {
            return
        }
        if captureInFlight {
            pendingCapture = true
            return
        }
        captureInFlight = true
        lastCaptureStartedAtMs = epochMilliseconds()

        Task { [weak self] in
            guard let self else {
                return
            }
            do {
                let image = try await self.captureImage(for: target)
                let pixels = await Task.detached(priority: .utility) {
                    Self.downsampledGrayscalePixels(image)
                }.value
                guard self.isMaterialChange(pixels) else {
                    self.completeCapture()
                    return
                }
                let text = try await Task.detached(priority: .utility) {
                    try Self.recognizeText(in: image)
                }.value
                if let text = bounded(text, limit: 16_384) {
                    self.onResult(
                        OCRResult(
                            target: target,
                            text: text,
                            observedAtMs: epochMilliseconds()
                        )
                    )
                }
            } catch {
                self.onGap(Self.sanitizedCaptureError(error))
            }
            self.completeCapture()
        }
    }

    private func completeCapture() {
        captureInFlight = false
        if pendingCapture {
            pendingCapture = false
            scheduleCapture(after: 0, reason: "pending")
        }
    }

    private func captureImage(for target: ScreenCaptureTarget) async throws -> CGImage {
        let shareableContent = try await SCShareableContent.excludingDesktopWindows(
            true,
            onScreenWindowsOnly: true
        )
        let candidates = shareableContent.windows.filter {
            $0.owningApplication?.processID == target.processIdentifier
                && $0.isOnScreen
                && $0.windowLayer == 0
        }
        guard let window = bestWindow(candidates, targetBounds: target.windowBounds) else {
            throw ObserverCaptureError.foregroundWindowUnavailable
        }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let configuration = SCStreamConfiguration()
        configuration.showsCursor = false
        configuration.ignoreShadowsSingleWindow = true
        configuration.backgroundColor = .clear

        let pointWidth = max(1, window.frame.width)
        let pointHeight = max(1, window.frame.height)
        let nativeScale = 2.0
        let nativePixels = pointWidth * pointHeight * nativeScale * nativeScale
        let boundScale = nativePixels > 2_500_000
            ? sqrt(2_500_000 / nativePixels)
            : 1
        configuration.width = max(1, Int(pointWidth * nativeScale * boundScale))
        configuration.height = max(1, Int(pointHeight * nativeScale * boundScale))
        return try await SCScreenshotManager.captureImage(
            contentFilter: filter,
            configuration: configuration
        )
    }

    private func bestWindow(_ windows: [SCWindow], targetBounds: CGRect?) -> SCWindow? {
        guard let targetBounds else {
            return windows.max { left, right in
                left.frame.width * left.frame.height < right.frame.width * right.frame.height
            }
        }
        return windows.min { left, right in
            windowDistance(left.frame, targetBounds) < windowDistance(right.frame, targetBounds)
        }
    }

    private func windowDistance(_ left: CGRect, _ right: CGRect) -> CGFloat {
        abs(left.midX - right.midX)
            + abs(left.midY - right.midY)
            + abs(left.width - right.width)
            + abs(left.height - right.height)
    }

    private func isMaterialChange(_ pixels: [UInt8]) -> Bool {
        defer { previousPixels = pixels }
        guard let previousPixels, previousPixels.count == pixels.count else {
            return true
        }
        var totalDifference = 0
        for (left, right) in zip(previousPixels, pixels) {
            totalDifference += abs(Int(left) - Int(right))
        }
        let meanDifference = Double(totalDifference) / Double(max(1, pixels.count))
        return meanDifference >= 2.0
    }

    nonisolated private static func downsampledGrayscalePixels(
        _ image: CGImage
    ) -> [UInt8] {
        var pixels = [UInt8](repeating: 0, count: 64 * 64)
        pixels.withUnsafeMutableBytes { buffer in
            guard let context = CGContext(
                data: buffer.baseAddress,
                width: 64,
                height: 64,
                bitsPerComponent: 8,
                bytesPerRow: 64,
                space: CGColorSpaceCreateDeviceGray(),
                bitmapInfo: CGImageAlphaInfo.none.rawValue
            ) else {
                return
            }
            context.interpolationQuality = .medium
            context.draw(image, in: CGRect(x: 0, y: 0, width: 64, height: 64))
        }
        return pixels
    }

    nonisolated private static func recognizeText(in image: CGImage) throws -> String {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hans", "en-US"]
        request.usesLanguageCorrection = true
        request.minimumTextHeight = 0.008
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        try handler.perform([request])
        let lines = (request.results ?? [])
            .prefix(512)
            .compactMap { $0.topCandidates(1).first?.string }
        return lines.joined(separator: "\n")
    }

    nonisolated private static func sanitizedCaptureError(_ error: Error) -> String {
        if let captureError = error as? ObserverCaptureError {
            return captureError.rawValue
        }
        return "screen_capture_failed"
    }
}

private enum ObserverCaptureError: String, Error {
    case foregroundWindowUnavailable = "foreground_window_unavailable"
}
