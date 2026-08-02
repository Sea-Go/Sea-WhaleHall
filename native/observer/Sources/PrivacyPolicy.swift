import ApplicationServices
import Foundation

struct CaptureDecision {
    let allowed: Bool
    let redactions: [String]
}

struct PrivacyPolicy {
    private static let deniedBundleIdentifiers: Set<String> = [
        "2buA8C4S2C.com.agilebits.onepassword7-helper".lowercased(),
        "com.1password.1password",
        "com.apple.keychainaccess",
        "com.apple.loginwindow",
        "com.apple.passwords",
        "com.apple.securityagent",
        "com.apple.systempreferences",
        "com.apple.wallet",
        "com.apple.passd",
        "com.bitwarden.desktop",
        "com.dashlane.dashlane",
        "com.enpass.Enpass".lowercased(),
        "com.lastpass.LastPass".lowercased(),
        "com.ledger.live",
        "com.microsoft.autoupdate.fba",
        "com.okta.mobile",
        "com.trezor.desktop",
        "org.keepassxc.keepassxc",
    ]

    private static let deniedApplicationFragments = [
        "1password", "authenticator", "bank", "banking", "bitwarden", "broker",
        "crypto wallet", "dashlane", "enpass", "keepass", "keychain", "lastpass",
        "ledger live", "password", "trading", "trezor", "wallet", "密码",
        "认证器", "银行", "钥匙串", "钱包",
    ]

    private static let deniedWindowFragments = [
        "api key", "authentication", "authorization", "banking", "broker",
        "card number", "checkout", "credit card", "cvc", "cvv", "incognito",
        "inprivate", "log in", "login", "one-time password", "otp", "passcode",
        "password", "payment", "private browsing", "private key", "recovery code",
        "recovery key", "seed phrase", "security code", "sign in", "trading",
        "two-factor", "verification code", "verify identity", "2fa", "无痕",
        "付款", "支付", "登录", "密码", "恢复代码", "恢复密钥", "私钥",
        "验证码", "认证", "身份验证", "银行", "银行卡", "隐私浏览",
    ]

    static func decision(
        bundleIdentifier: String,
        applicationName: String,
        windowTitle: String?,
        focusedRole: String?,
        focusedSubrole: String?,
        focusedLabel: String? = nil,
        finalValue: String? = nil,
        visibleText: String? = nil,
        configuredExclusions: Set<String>
    ) -> CaptureDecision {
        let normalizedBundle = bundleIdentifier.lowercased()
        if configuredExclusions.contains(normalizedBundle) {
            return CaptureDecision(allowed: false, redactions: ["user_excluded_application"])
        }
        if deniedBundleIdentifiers.contains(normalizedBundle) {
            return CaptureDecision(allowed: false, redactions: ["sensitive_application"])
        }

        let normalizedApp = applicationName.lowercased()
        if deniedApplicationFragments.contains(where: normalizedApp.contains) {
            return CaptureDecision(allowed: false, redactions: ["sensitive_application"])
        }

        if let windowTitle {
            let normalizedTitle = windowTitle.lowercased()
            if deniedWindowFragments.contains(where: normalizedTitle.contains) {
                return CaptureDecision(allowed: false, redactions: ["sensitive_or_private_window"])
            }
        }
        if let visibleText {
            let normalizedVisibleText = visibleText.lowercased()
            let privateMarkers = [
                "incognito mode", "inprivate browsing", "private browsing",
                "you've gone incognito", "无痕浏览", "隐私浏览",
            ]
            if privateMarkers.contains(where: normalizedVisibleText.contains) {
                return CaptureDecision(
                    allowed: false,
                    redactions: ["private_window"]
                )
            }
            if containsSensitiveText(normalizedVisibleText) {
                return CaptureDecision(
                    allowed: false,
                    redactions: ["sensitive_visible_content"]
                )
            }
        }
        let normalizedFocusedLabel = focusedLabel?.lowercased() ?? ""
        if containsSensitiveText(normalizedFocusedLabel)
            || containsSensitiveControlLabel(normalizedFocusedLabel)
        {
            return CaptureDecision(
                allowed: false,
                redactions: ["sensitive_focused_control"]
            )
        }
        if let finalValue,
           looksLikeSensitiveNumericValue(
               finalValue,
               surroundingText: [
                   windowTitle,
                   focusedLabel,
                   visibleText,
               ].compactMap { $0 }.joined(separator: "\n")
           )
        {
            return CaptureDecision(
                allowed: false,
                redactions: ["sensitive_final_value"]
            )
        }

        let normalizedRole = focusedRole?.lowercased() ?? ""
        let normalizedSubrole = focusedSubrole?.lowercased() ?? ""
        if normalizedRole.contains("secure")
            || normalizedRole.contains("password")
            || normalizedSubrole.contains("secure")
            || normalizedSubrole.contains("password")
        {
            return CaptureDecision(allowed: false, redactions: ["protected_input"])
        }
        return CaptureDecision(allowed: true, redactions: [])
    }

    private static func containsSensitiveText(_ normalizedText: String) -> Bool {
        let markers = [
            "2fa", "api key", "authentication code", "bank account",
            "card number", "confirmation code", "credit card", "cvc", "cvv",
            "one-time password", "otp", "passcode", "password", "payment",
            "private key", "recovery code", "recovery key", "seed phrase",
            "security code", "two-factor", "verification code", "付款", "信用卡",
            "动态口令", "安全码", "支付", "密码", "恢复代码", "恢复密钥",
            "私钥", "银行卡", "验证码", "认证",
        ]
        return markers.contains(where: normalizedText.contains)
    }

    private static func containsSensitiveControlLabel(_ normalizedText: String) -> Bool {
        let markers = [
            "checkout", "log in", "login", "sign in", "verify identity",
            "结账", "登录", "身份验证",
        ]
        return markers.contains(where: normalizedText.contains)
    }

    private static func looksLikeSensitiveNumericValue(
        _ value: String,
        surroundingText: String
    ) -> Bool {
        let digits = value.filter(\.isNumber)
        guard digits.count == value.filter({ !$0.isWhitespace && $0 != "-" }).count
        else {
            return false
        }
        if (13...19).contains(digits.count) {
            return true
        }
        guard (3...8).contains(digits.count) else {
            return false
        }
        let context = surroundingText.lowercased()
        return containsSensitiveText(context)
    }

    static func isProtected(element: AXUIElement) -> Bool {
        let role = attributeString(element, kAXRoleAttribute)
        let subrole = attributeString(element, kAXSubroleAttribute)
        let normalized = "\(role ?? "") \(subrole ?? "")".lowercased()
        return normalized.contains("secure") || normalized.contains("password")
    }
}

func attributeValue(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var result: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &result) == .success else {
        return nil
    }
    return result
}

func attributeString(_ element: AXUIElement, _ attribute: String) -> String? {
    guard let raw = attributeValue(element, attribute) else {
        return nil
    }
    if let value = raw as? String {
        return bounded(value, limit: 16_384)
    }
    if let value = raw as? NSAttributedString {
        return bounded(value.string, limit: 16_384)
    }
    if let number = raw as? NSNumber {
        return number.stringValue
    }
    return nil
}

func attributeBool(_ element: AXUIElement, _ attribute: String) -> Bool? {
    guard let raw = attributeValue(element, attribute) else {
        return nil
    }
    if let value = raw as? Bool {
        return value
    }
    if let number = raw as? NSNumber {
        return number.boolValue
    }
    return nil
}

func attributeElement(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
    guard let value = attributeValue(element, attribute),
          CFGetTypeID(value) == AXUIElementGetTypeID()
    else {
        return nil
    }
    return unsafeDowncast(value, to: AXUIElement.self)
}

func attributeElements(_ element: AXUIElement, _ attribute: String) -> [AXUIElement] {
    guard let value = attributeValue(element, attribute) as? [AXUIElement] else {
        return []
    }
    return value
}

func attributePoint(_ element: AXUIElement, _ attribute: String) -> CGPoint? {
    guard let value = attributeValue(element, attribute),
          CFGetTypeID(value) == AXValueGetTypeID()
    else {
        return nil
    }
    let axValue = unsafeDowncast(value, to: AXValue.self)
    guard AXValueGetType(axValue) == .cgPoint else {
        return nil
    }
    var point = CGPoint.zero
    return AXValueGetValue(axValue, .cgPoint, &point) ? point : nil
}

func attributeSize(_ element: AXUIElement, _ attribute: String) -> CGSize? {
    guard let value = attributeValue(element, attribute),
          CFGetTypeID(value) == AXValueGetTypeID()
    else {
        return nil
    }
    let axValue = unsafeDowncast(value, to: AXValue.self)
    guard AXValueGetType(axValue) == .cgSize else {
        return nil
    }
    var size = CGSize.zero
    return AXValueGetValue(axValue, .cgSize, &size) ? size : nil
}
