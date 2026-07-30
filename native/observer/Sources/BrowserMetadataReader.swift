import AppKit
import CoreServices
import Foundation

struct BrowserPageSnapshot {
    let title: String
    let sanitizedURL: String
    let privateWindow: Bool
}

@MainActor
final class BrowserMetadataReader {
    private let chromiumBundleIdentifiers: Set<String> = [
        "com.google.chrome",
        "com.google.chrome.beta",
        "com.google.chrome.canary",
        "com.brave.browser",
        "com.microsoft.edgemac",
        "org.chromium.chromium",
        "company.thebrowser.browser",
    ]

    func supports(bundleIdentifier: String) -> Bool {
        let normalized = bundleIdentifier.lowercased()
        return normalized == "com.apple.safari"
            || normalized == "com.apple.safaritechnologypreview"
            || chromiumBundleIdentifiers.contains(normalized)
    }

    func isBrowserLike(bundleIdentifier: String, applicationName: String) -> Bool {
        if supports(bundleIdentifier: bundleIdentifier) {
            return true
        }
        let identifier = bundleIdentifier.lowercased()
        let name = applicationName.lowercased()
        let markers = [
            "browser", "chrome", "chromium", "duckduckgo", "edge", "firefox",
            "librewolf", "opera", "orion", "safari", "vivaldi", "waterfox",
            "zen browser", "浏览器",
        ]
        return markers.contains {
            identifier.contains($0) || name.contains($0)
        }
    }

    func readForegroundPage(bundleIdentifier: String) -> BrowserPageSnapshot? {
        let normalized = bundleIdentifier.lowercased()
        guard bundleIdentifier.count <= 256,
              bundleIdentifier.range(
                  of: #"^[A-Za-z0-9.-]+$"#,
                  options: .regularExpression
              ) != nil
        else {
            return nil
        }
        // Safari does not expose a public, reliable private-window state.
        // Fail closed rather than receiving a private tab title/URL.
        guard normalized != "com.apple.safari",
              normalized != "com.apple.safaritechnologypreview"
        else {
            return nil
        }
        guard Self.automationAuthorization(
            bundleIdentifier: bundleIdentifier,
            prompt: false
        ) == "authorized" else {
            return nil
        }
        let source: String
        if chromiumBundleIdentifiers.contains(normalized) {
            source = """
            tell application id "\(bundleIdentifier)"
                if (count of windows) is 0 then return ""
                set windowMode to mode of front window as text
                if windowMode contains "incognito" then return "__WHALEHALL_PRIVATE__"
                set unitSeparator to ASCII character 31
                set tabTitle to title of active tab of front window
                set tabURL to URL of active tab of front window
                return tabTitle & unitSeparator & tabURL & unitSeparator & windowMode
            end tell
            """
        } else {
            return nil
        }

        var error: NSDictionary?
        guard let descriptor = NSAppleScript(source: source)?
            .executeAndReturnError(&error),
            error == nil,
            let value = descriptor.stringValue,
            !value.isEmpty
        else {
            return nil
        }
        if value == "__WHALEHALL_PRIVATE__" {
            return BrowserPageSnapshot(
                title: "",
                sanitizedURL: "",
                privateWindow: true
            )
        }
        let parts = value.components(separatedBy: "\u{001F}")
        guard parts.count >= 2,
              let title = bounded(parts[0], limit: 2_048),
              let sanitizedURL = sanitizeURL(parts[1])
        else {
            return nil
        }
        let mode = parts.count > 2 ? parts[2].lowercased() : ""
        let normalizedTitle = title.lowercased()
        let privateWindow = mode.contains("incognito")
            || mode.contains("private")
            || normalizedTitle.contains("incognito")
            || normalizedTitle.contains("inprivate")
            || normalizedTitle.contains("private browsing")
            || normalizedTitle.contains("无痕")
            || normalizedTitle.contains("隐私浏览")
        return BrowserPageSnapshot(
            title: title,
            sanitizedURL: sanitizedURL,
            privateWindow: privateWindow
        )
    }

    nonisolated static func automationAuthorization(
        bundleIdentifier: String,
        prompt: Bool
    ) -> String {
        guard let data = bundleIdentifier.data(using: .utf8), !data.isEmpty else {
            return "unavailable"
        }
        var address = AEAddressDesc()
        let createStatus = data.withUnsafeBytes { bytes in
            AECreateDesc(
                DescType(typeApplicationBundleID),
                bytes.baseAddress,
                data.count,
                &address
            )
        }
        guard createStatus == noErr else {
            return "unavailable"
        }
        defer { AEDisposeDesc(&address) }

        let status = AEDeterminePermissionToAutomateTarget(
            &address,
            AEEventClass(typeWildCard),
            AEEventID(typeWildCard),
            prompt
        )
        switch status {
        case noErr:
            return "authorized"
        case OSStatus(errAEEventWouldRequireUserConsent):
            return "not_determined"
        case OSStatus(errAEEventNotPermitted):
            return "denied"
        default:
            return "unavailable"
        }
    }

    private func sanitizeURL(_ rawValue: String) -> String? {
        guard let boundedValue = bounded(rawValue, limit: 16_384),
              var components = URLComponents(string: boundedValue),
              let scheme = components.scheme?.lowercased(),
              ["http", "https"].contains(scheme)
        else {
            return nil
        }
        components.user = nil
        components.password = nil
        components.fragment = nil
        let sensitiveFragments = [
            "access", "auth", "code", "credential", "jwt", "key", "nonce",
            "otp", "password", "secret", "session", "signature", "ticket", "token",
        ]
        components.queryItems = components.queryItems?.map { item in
            let normalizedName = item.name.lowercased()
            if sensitiveFragments.contains(where: normalizedName.contains) {
                return URLQueryItem(name: item.name, value: "[redacted]")
            }
            return URLQueryItem(
                name: String(item.name.prefix(128)),
                value: item.value.map { String($0.prefix(1_024)) }
            )
        }
        return bounded(components.string, limit: 16_384)
    }
}
