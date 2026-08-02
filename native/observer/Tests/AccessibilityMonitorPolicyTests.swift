import Foundation

@main
enum AccessibilityMonitorPolicyTests {
    static func main() {
        let readyHandshake = InputTapStartupHandshake()
        DispatchQueue.global().async {
            readyHandshake.complete(ready: true)
        }
        precondition(readyHandshake.wait(timeout: .seconds(1)) == true)

        let failedHandshake = InputTapStartupHandshake()
        failedHandshake.complete(ready: false)
        precondition(failedHandshake.wait(timeout: .seconds(1)) == false)

        let timedOutHandshake = InputTapStartupHandshake()
        precondition(timedOutHandshake.wait(timeout: .milliseconds(1)) == nil)

        // A cancelled timer from generation 1 must not drain generation 3's
        // accumulator after stop (generation 2) followed by start.
        precondition(!InputBucketTimerPolicy.accepts(
            callbackGeneration: 1,
            currentGeneration: 3,
            stopped: false,
            tapReady: true
        ))
        precondition(InputBucketTimerPolicy.accepts(
            callbackGeneration: 3,
            currentGeneration: 3,
            stopped: false,
            tapReady: true
        ))
        precondition(!InputBucketTimerPolicy.accepts(
            callbackGeneration: 3,
            currentGeneration: 3,
            stopped: true,
            tapReady: true
        ))
        precondition(InputMonitorRetryPolicy.delay(forAttempt: 0) == 1)
        precondition(InputMonitorRetryPolicy.delay(forAttempt: 1) == 5)
        precondition(InputMonitorRetryPolicy.delay(forAttempt: 2) == 15)
        precondition(InputMonitorRetryPolicy.delay(forAttempt: 3) == 60)
        precondition(InputMonitorRetryPolicy.delay(forAttempt: 99) == 60)
        precondition(
            InputMonitorFailurePolicy.disposition(permissionAvailable: true)
                == .retrySensor
        )
        precondition(
            InputMonitorFailurePolicy.disposition(permissionAvailable: false)
                == .permissionRevoked
        )
        precondition(InputCollectionGatePolicy.enabledAfterStart(
            tapReady: true,
            activeCaptureAllowed: true
        ))
        precondition(!InputCollectionGatePolicy.enabledAfterStart(
            tapReady: true,
            activeCaptureAllowed: false
        ))
        precondition(!InputCollectionGatePolicy.enabledAfterStart(
            tapReady: false,
            activeCaptureAllowed: true
        ))

        precondition(
            AccessibilityTextFlushPolicy.action(
                pendingNotification: "ax.valueChanged",
                incomingNotification: "ax.visibleContentChanged"
            ) == .ignore
        )
        precondition(
            AccessibilityTextFlushPolicy.action(
                pendingNotification: "ax.valueChanged",
                incomingNotification: "ax.valueChanged"
            ) == .schedule
        )
        precondition(
            AccessibilityTextFlushPolicy.action(
                pendingNotification: "ax.valueChanged",
                incomingNotification: "ax.focusChanged"
            ) == .flushThenSchedule
        )
        precondition(
            AccessibilityTextFlushPolicy.delayMilliseconds(
                startedAtMs: 1_000,
                nowMs: 1_000
            ) == 2_000
        )
        precondition(
            AccessibilityTextFlushPolicy.delayMilliseconds(
                startedAtMs: 1_000,
                nowMs: 10_500
            ) == 500
        )
        precondition(
            AccessibilityTextFlushPolicy.delayMilliseconds(
                startedAtMs: 1_000,
                nowMs: 11_000
            ) == 0
        )

        var captureGate = AccessibilityCaptureGate()
        func wouldFlushPendingValueOnFocus() -> Bool {
            captureGate.acceptsNonFocusSnapshots
                && AccessibilityTextFlushPolicy.action(
                    pendingNotification: "ax.valueChanged",
                    incomingNotification: "ax.focusChanged"
                ) == .flushThenSchedule
        }
        precondition(captureGate.state == .awaitingFocusBaseline)
        precondition(!captureGate.acceptsNonFocusSnapshots)

        // An allowed non-focus decision must not open an uninitialized gate.
        precondition(captureGate.applyDecision(
            allowed: true,
            focusBaselineEstablished: false
        ) == .preservePending)
        precondition(captureGate.state == .awaitingFocusBaseline)

        precondition(captureGate.applyDecision(
            allowed: true,
            focusBaselineEstablished: true
        ) == .preservePending)
        precondition(captureGate.state == .allowed)
        precondition(captureGate.acceptsNonFocusSnapshots)
        precondition(wouldFlushPendingValueOnFocus())

        // A denied/private decision is sticky for pending value notifications.
        precondition(captureGate.applyDecision(
            allowed: false,
            focusBaselineEstablished: false
        ) == .discardPending)
        precondition(captureGate.state == .blocked)
        precondition(!captureGate.acceptsNonFocusSnapshots)
        precondition(captureGate.applyDecision(
            allowed: true,
            focusBaselineEstablished: false
        ) == .preservePending)
        precondition(captureGate.state == .blocked)
        precondition(!wouldFlushPendingValueOnFocus())

        // Recovery starts closed and requires a new allowed focus baseline.
        precondition(captureGate.beginFocusBaseline() == .discardPending)
        precondition(captureGate.state == .awaitingFocusBaseline)
        precondition(captureGate.applyDecision(
            allowed: true,
            focusBaselineEstablished: false
        ) == .preservePending)
        precondition(captureGate.state == .awaitingFocusBaseline)
        precondition(!wouldFlushPendingValueOnFocus())
        precondition(captureGate.applyDecision(
            allowed: true,
            focusBaselineEstablished: true
        ) == .preservePending)
        precondition(captureGate.state == .allowed)
        precondition(captureGate.acceptsNonFocusSnapshots)

        let windowBounds = CGRect(x: 0, y: 0, width: 100, height: 100)
        func editableCandidate(
            x: CGFloat,
            y: CGFloat,
            width: CGFloat = 20,
            height: CGFloat = 20,
            hidden: Bool = false,
            accessibilityFocused: Bool = false,
            systemFocused: Bool = false
        ) -> AccessibilityEditableCandidateDescriptor {
            AccessibilityEditableCandidateDescriptor(
                hidden: hidden,
                bounds: CGRect(
                    x: x,
                    y: y,
                    width: width,
                    height: height
                ),
                accessibilityFocused: accessibilityFocused,
                systemFocused: systemFocused
            )
        }

        let partiallyVisible = editableCandidate(x: 90, y: 90)
        precondition(
            AccessibilityEditableSelectionPolicy.isVisible(
                partiallyVisible,
                within: windowBounds
            )
        )
        precondition(
            !AccessibilityEditableSelectionPolicy.isVisible(
                editableCandidate(x: 100, y: 0),
                within: windowBounds
            )
        )
        precondition(
            !AccessibilityEditableSelectionPolicy.isVisible(
                editableCandidate(x: 10, y: 10, width: 0),
                within: windowBounds
            )
        )
        precondition(
            !AccessibilityEditableSelectionPolicy.isVisible(
                editableCandidate(x: 10, y: 10, hidden: true),
                within: windowBounds
            )
        )
        precondition(
            !AccessibilityEditableSelectionPolicy.isVisible(
                partiallyVisible,
                within: nil
            )
        )

        let twoVisibleCandidates = [
            editableCandidate(x: 10, y: 10),
            editableCandidate(x: 40, y: 10),
        ]
        precondition(
            AccessibilityEditableSelectionPolicy.selectedIndex(
                candidates: [twoVisibleCandidates[0]],
                within: windowBounds
            ) == 0
        )
        precondition(
            AccessibilityEditableSelectionPolicy.selectedIndex(
                candidates: twoVisibleCandidates,
                within: windowBounds
            ) == nil
        )
        precondition(
            AccessibilityEditableSelectionPolicy.selectedIndex(
                candidates: [
                    twoVisibleCandidates[0],
                    editableCandidate(
                        x: 40,
                        y: 10,
                        systemFocused: true
                    ),
                ],
                within: windowBounds
            ) == 1
        )
        precondition(
            AccessibilityEditableSelectionPolicy.selectedIndex(
                candidates: [
                    editableCandidate(
                        x: 10,
                        y: 10,
                        accessibilityFocused: true
                    ),
                    twoVisibleCandidates[1],
                ],
                within: windowBounds
            ) == 0
        )
        precondition(
            AccessibilityEditableSelectionPolicy.selectedIndex(
                candidates: [
                    editableCandidate(
                        x: 10,
                        y: 10,
                        accessibilityFocused: true
                    ),
                    editableCandidate(
                        x: 40,
                        y: 10,
                        accessibilityFocused: true
                    ),
                ],
                within: windowBounds
            ) == nil
        )
    }
}
