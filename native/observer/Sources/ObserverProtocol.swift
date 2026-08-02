import CryptoKit
import Foundation

let observerAdapterVersion = "observer-0.1.0"
let observerFrameSchemaVersion = "observer-frame.v1"
let rawObservationSchemaVersion = "raw-observation.v2"
let maximumProtocolFrameBytes = 512 * 1_024

func epochMilliseconds() -> Int64 {
    Int64((Date().timeIntervalSince1970 * 1_000).rounded(.down))
}

func bounded(_ value: String?, limit: Int) -> String? {
    guard let value else {
        return nil
    }
    let sanitized = value
        .replacingOccurrences(of: "\u{0000}", with: "")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !sanitized.isEmpty else {
        return nil
    }
    return String(sanitized.prefix(limit))
}

func opaqueIdentifier(_ components: [String], prefix: String = "ow1") -> String {
    let digest = SHA256.hash(data: Data(components.joined(separator: "\u{001F}").utf8))
    let encoded = digest.prefix(16).map { String(format: "%02x", $0) }.joined()
    return "\(prefix)_\(encoded)"
}

struct ObserverConfiguration {
    var captureContent = true
    var excludedBundleIdentifiers = Set<String>()

    init(dictionary: [String: Any]?) {
        guard let dictionary else {
            return
        }
        if let captureContent = dictionary["captureContent"] as? Bool {
            self.captureContent = captureContent
        }
        if let excluded = dictionary["excludedBundleIds"] as? [String] {
            excludedBundleIdentifiers = Set(
                excluded.compactMap { bounded($0, limit: 256)?.lowercased() }
            )
        }
    }
}

struct PermissionSnapshot: Equatable {
    let accessibility: Bool
    let screenRecording: Bool
    let inputMonitoring: Bool
    let automation: String

    var dictionary: [String: Any] {
        [
            "accessibility": accessibility ? "authorized" : "denied",
            "screenRecording": screenRecording ? "authorized" : "denied",
            "inputMonitoring": inputMonitoring ? "authorized" : "denied",
            "automation": automation,
        ]
    }
}

struct ObservationEnvelope {
    let kind: String
    let startedAtMs: Int64
    let endedAtMs: Int64
    let sensor: String
    let appIdentifier: String
    let appName: String
    let opaqueWindowIdentifier: String?
    let reliability: String
    let coverage: [String]
    let redactions: [String]
    let metadata: [String: Any]
    let content: [String: Any]?

    var dictionary: [String: Any] {
        var subject: [String: Any] = [
            "appId": appIdentifier,
            "appName": appName,
        ]
        if let opaqueWindowIdentifier {
            subject["opaqueWindowId"] = opaqueWindowIdentifier
        }

        var result: [String: Any] = [
            "schemaVersion": rawObservationSchemaVersion,
            "kind": kind,
            "interval": [
                "startedAtMs": startedAtMs,
                "endedAtMs": endedAtMs,
            ],
            "source": [
                "sensor": sensor,
                "adapterVersion": observerAdapterVersion,
            ],
            "subject": subject,
            "reliability": reliability,
            "coverage": coverage,
            "redactions": redactions,
            "metadata": metadata,
        ]
        if let content, !content.isEmpty {
            result["content"] = content
        }
        return result
    }
}

final class FrameEmitter: @unchecked Sendable {
    private let bootIdentifier = UUID().uuidString.lowercased()
    private let lock = NSLock()
    private let outputQueue = DispatchQueue(
        label: "com.seago.whalehall.observer.stdout",
        qos: .utility
    )
    private var nextSequence: UInt64 = 1
    private var unacknowledged: [(sequence: UInt64, data: Data)] = []
    private var unacknowledgedBytes = 0
    private var reportingGap = false
    private var droppedFrames = 0
    private var pendingActivityBucket: ObservationEnvelope?
    private var pendingLatestOCR: ObservationEnvelope?

    var bootId: String {
        bootIdentifier
    }

    func emitReady(
        permissionSnapshot: PermissionSnapshot,
        inputActivityHealth: InputActivityHealth
    ) {
        var fields = inputActivityHealth.protocolFields
        fields.merge([
            "adapterVersion": observerAdapterVersion,
            "authorizationReason": "startup_snapshot",
            "minimumMacOSVersion": "14.0",
            "capabilities": [
                "workspace": true,
                "accessibility": true,
                "screenOCR": true,
                "browserAppleEvents": true,
                "browserAppleEventsPrompted": false,
                "inputActivity": true,
                "storesScreenshots": false,
                "readsKeyValues": false,
            ],
            "permissions": permissionSnapshot.dictionary,
        ]) { _, new in new }
        emitUnsequenced(
            type: "ready",
            fields: fields
        )
    }

    func emitPermissionStatus(
        _ snapshot: PermissionSnapshot,
        reason: String,
        inputActivityHealth: InputActivityHealth
    ) {
        var fields = inputActivityHealth.protocolFields
        fields.merge([
            "authorizationReason": reason,
            "permissions": snapshot.dictionary,
        ]) { _, new in new }
        emitUnsequenced(
            type: "permissionStatus",
            fields: fields
        )
    }

    func emitHeartbeat(
        state: String,
        permissionSnapshot: PermissionSnapshot,
        inputActivityHealth: InputActivityHealth
    ) {
        lock.lock()
        let queuedFrames = unacknowledged.count
        let queuedBytes = unacknowledgedBytes
        lock.unlock()
        var fields = inputActivityHealth.protocolFields
        fields.merge([
            "state": state,
            "authorizationReason": "heartbeat_check",
            "permissions": permissionSnapshot.dictionary,
            "unackedFrames": queuedFrames,
            "unackedBytes": queuedBytes,
        ]) { _, new in new }
        emitUnsequenced(
            type: "heartbeat",
            fields: fields
        )
    }

    func emitCommandResult(id: String, ok: Bool, state: String, errorCode: String? = nil) {
        var fields: [String: Any] = [
            "id": id,
            "ok": ok,
            "state": state,
        ]
        if let errorCode {
            fields["error"] = ["code": errorCode]
        }
        emitUnsequenced(type: "commandResult", fields: fields)
    }

    func emitError(code: String, recoverable: Bool) {
        emitUnsequenced(
            type: "error",
            fields: [
                "code": code,
                "recoverable": recoverable,
            ]
        )
    }

    func flushOutput() {
        outputQueue.sync {}
    }

    @discardableResult
    func emitObservation(_ observation: ObservationEnvelope) -> Bool {
        lock.lock()
        defer { lock.unlock() }

        guard let data = encodeObservationLocked(observation) else {
            return false
        }
        if isAtCapacity(adding: data.count) {
            retainOverflowLocked(observation)
            reportDroppedFrameLocked()
            return false
        }
        appendObservationLocked(data)
        return true
    }

    private func encodeObservationLocked(_ observation: ObservationEnvelope) -> Data? {
        let sequence = nextSequence
        let frame: [String: Any] = [
            "type": "observation",
            "schemaVersion": observerFrameSchemaVersion,
            "bootId": bootIdentifier,
            "sequence": sequence,
            "observedAtMs": epochMilliseconds(),
            "observation": observation.dictionary,
        ]

        guard let data = encodedLine(frame) else {
            return nil
        }
        if data.count > maximumProtocolFrameBytes {
            writeUnsequencedLocked(
                type: "error",
                fields: ["code": "frame_too_large", "recoverable": true]
            )
            return nil
        }
        return data
    }

    private func isAtCapacity(adding bytes: Int) -> Bool {
        unacknowledged.count >= 256
            || unacknowledgedBytes + bytes > 16 * 1_024 * 1_024
    }

    private func appendObservationLocked(_ data: Data) {
        let sequence = nextSequence
        nextSequence += 1
        unacknowledged.append((sequence: sequence, data: data))
        unacknowledgedBytes += data.count
        enqueueOutput(data)
    }

    private func retainOverflowLocked(_ observation: ObservationEnvelope) {
        if observation.kind == "input.activityBucket" {
            if let pending = pendingActivityBucket,
               pending.appIdentifier == observation.appIdentifier
            {
                pendingActivityBucket = mergeActivityBuckets(pending, observation)
            } else {
                pendingActivityBucket = observation
            }
        } else if observation.sensor == "ocr" {
            // OCR is a latest-state signal. Retaining the newest completed
            // frame is more useful than replaying stale screen text.
            pendingLatestOCR = observation
        }
    }

    private func reportDroppedFrameLocked() {
        droppedFrames += 1
        guard !reportingGap else {
            return
        }
        reportingGap = true
        writeUnsequencedLocked(
            type: "gap",
            fields: [
                "reason": "parent_backpressure",
                "droppedFrames": droppedFrames,
                "coverage": ["unavailable"],
            ]
        )
    }

    func acknowledge(bootId: String, through sequence: UInt64) {
        guard bootId == bootIdentifier else {
            emitError(code: "ack_boot_id_mismatch", recoverable: true)
            return
        }
        lock.lock()
        while let first = unacknowledged.first, first.sequence <= sequence {
            unacknowledgedBytes -= first.data.count
            unacknowledged.removeFirst()
        }
        flushRetainedOverflowLocked()
        if reportingGap,
           pendingActivityBucket == nil,
           pendingLatestOCR == nil,
           unacknowledged.count < 192,
           unacknowledgedBytes < 12 * 1_024 * 1_024
        {
            if droppedFrames > 1 {
                writeUnsequencedLocked(
                    type: "gap",
                    fields: [
                        "reason": "parent_backpressure",
                        "droppedFrames": droppedFrames,
                        "coverage": ["unavailable"],
                    ]
                )
            }
            reportingGap = false
            droppedFrames = 0
        }
        lock.unlock()
    }

    private func flushRetainedOverflowLocked() {
        if let pendingActivityBucket,
           let data = encodeObservationLocked(pendingActivityBucket),
           !isAtCapacity(adding: data.count)
        {
            self.pendingActivityBucket = nil
            appendObservationLocked(data)
        }
        if let pendingLatestOCR,
           let data = encodeObservationLocked(pendingLatestOCR),
           !isAtCapacity(adding: data.count)
        {
            self.pendingLatestOCR = nil
            appendObservationLocked(data)
        }
    }

    private func mergeActivityBuckets(
        _ lhs: ObservationEnvelope,
        _ rhs: ObservationEnvelope
    ) -> ObservationEnvelope {
        func integer(_ value: Any?) -> Int {
            (value as? NSNumber)?.intValue ?? 0
        }
        func decimal(_ value: Any?) -> Double {
            (value as? NSNumber)?.doubleValue ?? 0
        }
        func bucketCount(_ envelope: ObservationEnvelope) -> Int {
            max(
                1,
                integer(envelope.metadata["coalescedBucketCount"])
            )
        }
        return ObservationEnvelope(
            kind: rhs.kind,
            startedAtMs: min(lhs.startedAtMs, rhs.startedAtMs),
            endedAtMs: max(lhs.endedAtMs, rhs.endedAtMs),
            sensor: rhs.sensor,
            appIdentifier: rhs.appIdentifier,
            appName: rhs.appName,
            opaqueWindowIdentifier: rhs.opaqueWindowIdentifier,
            reliability: rhs.reliability,
            coverage: rhs.coverage,
            redactions: Array(Set(lhs.redactions + rhs.redactions)).sorted(),
            metadata: [
                "keyCount": integer(lhs.metadata["keyCount"])
                    + integer(rhs.metadata["keyCount"]),
                "clickCount": integer(lhs.metadata["clickCount"])
                    + integer(rhs.metadata["clickCount"]),
                "scrollDelta": decimal(lhs.metadata["scrollDelta"])
                    + decimal(rhs.metadata["scrollDelta"]),
                "mouseDistance": decimal(lhs.metadata["mouseDistance"])
                    + decimal(rhs.metadata["mouseDistance"]),
                "coalescedBucketCount": bucketCount(lhs) + bucketCount(rhs),
            ],
            content: nil
        )
    }

    private func emitUnsequenced(type: String, fields: [String: Any]) {
        lock.lock()
        writeUnsequencedLocked(type: type, fields: fields)
        lock.unlock()
    }

    private func writeUnsequencedLocked(type: String, fields: [String: Any]) {
        var frame: [String: Any] = [
            "type": type,
            "schemaVersion": observerFrameSchemaVersion,
            "bootId": bootIdentifier,
            "observedAtMs": epochMilliseconds(),
        ]
        for (key, value) in fields {
            frame[key] = value
        }
        guard let data = encodedLine(frame), data.count <= maximumProtocolFrameBytes else {
            return
        }
        enqueueOutput(data)
    }

    private func enqueueOutput(_ data: Data) {
        outputQueue.async {
            FileHandle.standardOutput.write(data)
        }
    }

    private func encodedLine(_ object: [String: Any]) -> Data? {
        guard JSONSerialization.isValidJSONObject(object),
              var data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        else {
            return nil
        }
        data.append(0x0A)
        return data
    }
}

final class CommandInput: @unchecked Sendable {
    private weak var runtime: ObserverRuntime?

    init(runtime: ObserverRuntime) {
        self.runtime = runtime
    }

    func start() {
        Thread.detachNewThread { [weak self] in
            self?.readLoop()
        }
    }

    private func readLoop() {
        var buffer = Data()
        while true {
            let chunk = FileHandle.standardInput.availableData
            if chunk.isEmpty {
                Task { @MainActor [weak runtime] in
                    runtime?.parentDisconnected()
                }
                return
            }
            buffer.append(chunk)
            if buffer.count > maximumProtocolFrameBytes * 2 {
                Task { @MainActor [weak runtime] in
                    runtime?.protocolFailure(code: "input_buffer_overflow")
                }
                return
            }
            while let newlineIndex = buffer.firstIndex(of: 0x0A) {
                let line = Data(buffer[..<newlineIndex])
                buffer.removeSubrange(...newlineIndex)
                if line.isEmpty {
                    continue
                }
                guard line.count <= maximumProtocolFrameBytes else {
                    Task { @MainActor [weak runtime] in
                        runtime?.protocolFailure(code: "input_frame_too_large")
                    }
                    continue
                }
                Task { @MainActor [weak runtime] in
                    runtime?.handleCommandData(line)
                }
            }
        }
    }
}
