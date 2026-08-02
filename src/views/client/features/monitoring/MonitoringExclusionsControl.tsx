import { Save, ShieldOff } from "lucide-react";
import {
	useEffect,
	useMemo,
	useState,
	useSyncExternalStore,
} from "react";
import type { MonitoringController } from "./MonitoringController";
import "./MonitoringExclusionsControl.css";

export interface MonitoringExclusionsControlProps {
	controller: MonitoringController;
}

export function MonitoringExclusionsControl({
	controller,
}: MonitoringExclusionsControlProps) {
	const state = useSyncExternalStore(
		controller.subscribe,
		controller.getSnapshot,
		controller.getServerSnapshot,
	);
	const snapshot = "snapshot" in state ? state.snapshot : null;
	const persistedText = snapshot?.excludedAppIds.join("\n") ?? "";
	const [draft, setDraft] = useState(persistedText);
	const [validationError, setValidationError] = useState<string | null>(null);

	useEffect(() => {
		if (state.status === "idle") void controller.load();
	}, [controller, state.status]);

	useEffect(() => {
		setDraft(persistedText);
		setValidationError(null);
	}, [persistedText]);

	const parsed = useMemo(() => parseExcludedAppIds(draft), [draft]);
	const updating = state.status === "updating";
	const dirty =
		snapshot !== null &&
		(parsed.ok
			? parsed.appIds.join("\n") !== persistedText
			: draft.trim() !== persistedText);

	function save() {
		if (snapshot === null) return;
		const result = parseExcludedAppIds(draft);
		if (!result.ok) {
			setValidationError(result.message);
			return;
		}
		setValidationError(null);
		void controller.configure({
			enabled: snapshot.enabled,
			captureContent: snapshot.captureContent,
			excludedAppIds: result.appIds,
		});
	}

	return (
		<div className="monitoring-exclusions">
			<div className="monitoring-exclusions__heading">
				<ShieldOff size={17} aria-hidden="true" />
				<div>
					<strong>按应用排除</strong>
					<p>
						每行填写一个 macOS bundle ID。被排除应用的窗口、可见内容和键鼠统计都不会进入观察链路。
					</p>
				</div>
				<span>
					{snapshot
						? `当前排除 ${snapshot.excludedAppIds.length} 个应用`
						: "正在读取排除列表"}
				</span>
			</div>
			<label>
				<span>排除的 bundle ID</span>
				<textarea
					value={draft}
					rows={3}
					placeholder={"例如：\ncom.apple.Passwords\ncom.example.private"}
					disabled={snapshot === null || updating}
					onChange={(event) => {
						setDraft(event.currentTarget.value);
						setValidationError(null);
					}}
				/>
			</label>
			<div className="monitoring-exclusions__footer">
				<span className="monitoring-exclusions__message" role="status">
					{validationError ??
						(state.status === "error"
							? state.message
							: "保存后立即应用到本机观察器。")}
				</span>
				<button
					type="button"
					disabled={!dirty || updating}
					onClick={save}
				>
					<Save size={14} aria-hidden="true" />
					{updating && state.operation === "configure"
						? "正在保存…"
						: "保存排除列表"}
				</button>
			</div>
		</div>
	);
}

export type ExcludedAppIdParseResult =
	| { ok: true; appIds: string[] }
	| { ok: false; message: string };

export function parseExcludedAppIds(
	value: string,
): ExcludedAppIdParseResult {
	const appIds = [
		...new Set(
			value
				.split(/[\s,]+/u)
				.map((item) => item.trim())
				.filter(Boolean),
		),
	];
	if (appIds.length > 256) {
		return { ok: false, message: "最多可排除 256 个应用。" };
	}
	const invalid = appIds.find(
		(item) =>
			new TextEncoder().encode(item).byteLength > 256 ||
			!/^[A-Za-z0-9][A-Za-z0-9.-]*$/u.test(item),
	);
	if (invalid) {
		return {
			ok: false,
			message: `“${invalid.slice(0, 40)}” 不是有效的 bundle ID。`,
		};
	}
	return { ok: true, appIds };
}
