import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PetApp } from "./PetApp";
import "./styles.css";

// 临时调试脚手架（定位 pet 渲染器不就绪问题，定位后移除）：
// 把启动期错误写进页面 DOM（窗口显示后截图可读），并在失败时也调用
// petApi.ready() 让 bun 侧开门，避免窗口永远隐藏导致无法诊断。
import { petApi } from "./rpc";

function surfaceBootError(label: string, detail: string): void {
	console.error(`[pet][boot-debug] ${label}: ${detail}`);
	try {
		const div = document.createElement("div");
		div.style.cssText =
			"position:fixed;inset:0;background:#3a0b0b;color:#fff;font:11px/1.4 monospace;padding:10px;white-space:pre-wrap;z-index:9999;overflow:auto";
		div.textContent = `BOOT ${label}:\n${detail}`;
		document.body.appendChild(div);
	} catch {}
	try {
		petApi.ready();
	} catch {}
}

window.addEventListener("error", (event) => {
	surfaceBootError("error", event.error?.stack ?? event.message ?? "unknown");
});
window.addEventListener("unhandledrejection", (event) => {
	surfaceBootError(
		"unhandledrejection",
		String(event.reason?.stack ?? event.reason ?? "unknown"),
	);
});


try {
	console.log("[pet] main.tsx executing");
	try {
		const root = document.getElementById("root");
		if (!root) throw new Error("Missing #root element.");

		createRoot(root).render(
			<StrictMode>
				<PetApp />
			</StrictMode>,
		);
		console.log("[pet][boot-debug] PetApp render dispatched");
	} catch (error) {
		surfaceBootError(
			"mount-throw",
			error instanceof Error ? error.stack ?? error.message : String(error),
		);
	}
	console.log("[pet] PetApp mounted");
} catch (error) {
	console.error("[pet] main.tsx mount failed:", error);
}
