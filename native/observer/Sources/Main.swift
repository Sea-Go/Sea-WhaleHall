import AppKit
import Foundation

@main
struct WhaleHallObserverMain {
    @MainActor
    static func main() {
        guard #available(macOS 14.0, *) else {
            exit(EXIT_FAILURE)
        }
        let application = NSApplication.shared
        application.setActivationPolicy(.prohibited)
        let runtime = ObserverRuntime()
        runtime.run()
        application.run()
        withExtendedLifetime(runtime) {}
    }
}
