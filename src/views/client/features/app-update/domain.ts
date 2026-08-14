import type {
	AppUpdateReleaseSummary,
	AppUpdateSnapshot,
} from "../../../../shared/app-update";

export type AppUpdateOperation = "load" | "check" | "download" | "install";

export type AppUpdateControllerState =
	| { status: "idle" }
	| { status: "loading" }
	| {
			status: "ready";
			snapshot: AppUpdateSnapshot;
			operation: Exclude<AppUpdateOperation, "load"> | null;
	  }
	| {
			status: "error";
			snapshot: AppUpdateSnapshot | null;
			operation: AppUpdateOperation;
			message: string;
			retryable: true;
	  };

export function appUpdateRelease(
	snapshot: AppUpdateSnapshot,
): AppUpdateReleaseSummary | null {
	return "release" in snapshot ? snapshot.release : null;
}

export function appUpdateNeedsAttention(snapshot: AppUpdateSnapshot): boolean {
	return (
		snapshot.state === "available" ||
		snapshot.state === "downloading" ||
		snapshot.state === "verifying" ||
		snapshot.state === "ready" ||
		snapshot.state === "preparing_install" ||
		snapshot.state === "installing" ||
		(snapshot.state === "failed" && snapshot.release !== null)
	);
}

export function appUpdateFailureMessage(
	_reason: unknown,
	operation: AppUpdateOperation,
): string {
	if (operation === "load" || operation === "check") {
		return "暂时无法检查客户端更新，请确认网络连接后重试。";
	}
	if (operation === "download") {
		return "更新包下载失败，当前版本可以继续使用。";
	}
	if (operation === "install") {
		return "暂时无法安装更新，已保留当前版本和下载好的更新包。";
	}
	return "暂时无法完成客户端更新。";
}

export function formatUpdateSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
	const megabytes = bytes / (1024 * 1024);
	return `${megabytes >= 10 ? Math.round(megabytes) : megabytes.toFixed(1)} MB`;
}
