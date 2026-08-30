import AppKit
import ApplicationServices
import Foundation

private let expectedBundleIdentifier = "io.github.xlcyun.dsh-desktop"

/// 向 stderr 写入固定诊断并以失败状态结束 helper。
private func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(1)
}

/// 从 Accessibility 属性读取一个强类型值，并拒绝缺失或错误结果。
private func attribute<T>(_ element: AXUIElement, _ name: CFString, as type: T.Type) -> T {
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, name, &value)
    guard error == .success, let typed = value as? T else {
        fail("macOS close helper could not read the required Accessibility attribute")
    }
    return typed
}

/// 只按 exact PID 操作唯一 DSH Desktop 主窗口的原生关闭按钮。
@main
private enum MacOSCloseWindow {
    /// 校验进程与窗口身份后执行一次 AXPress，绝不发送 application Quit。
    static func main() {
        if CommandLine.arguments.count == 2, CommandLine.arguments[1] == "--probe-trust" {
            print(AXIsProcessTrusted() ? "trusted" : "untrusted")
            exit(AXIsProcessTrusted() ? 0 : 77)
        }
        guard CommandLine.arguments.count == 2,
              let rawPID = Int32(CommandLine.arguments[1]),
              rawPID > 0 else {
            fail("macOS close helper requires one positive Desktop PID")
        }
        guard AXIsProcessTrusted() else {
            fail("hosted runner has not pre-authorized Accessibility for the close helper")
        }
        guard let application = NSRunningApplication(processIdentifier: pid_t(rawPID)),
              !application.isTerminated,
              application.bundleIdentifier == expectedBundleIdentifier else {
            fail("macOS close helper PID is not the exact DSH Desktop application")
        }
        let applicationElement = AXUIElementCreateApplication(pid_t(rawPID))
        let windows: [AXUIElement] = attribute(applicationElement, kAXWindowsAttribute as CFString, as: [AXUIElement].self)
        let mainWindow: AXUIElement = attribute(applicationElement, kAXMainWindowAttribute as CFString, as: AXUIElement.self)
        guard windows.count == 1, CFEqual(windows[0], mainWindow) else {
            fail("macOS close helper requires exactly one main Desktop window")
        }
        let closeButton: AXUIElement = attribute(mainWindow, kAXCloseButtonAttribute as CFString, as: AXUIElement.self)
        let enabled: Bool = attribute(closeButton, kAXEnabledAttribute as CFString, as: Bool.self)
        guard enabled, AXUIElementPerformAction(closeButton, kAXPressAction as CFString) == .success else {
            fail("macOS Desktop close button did not accept AXPress")
        }
    }
}
