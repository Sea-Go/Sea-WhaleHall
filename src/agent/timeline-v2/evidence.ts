import { canonicalJson, type ReflectionHasher } from "../reflection/hash";
import {
	EVIDENCE_FACT_SCHEMA_VERSION,
	type CoverageLevel,
	type EvidenceAnchorV2,
	type EvidenceFactV2,
	type FactTemplateCode,
	type JsonPrimitive,
	type SemanticEventV2,
} from "./types";

const MAX_FACT_CONTENT_CHARACTERS = 320;

export class DeterministicEvidenceRenderer {
	constructor(private readonly hasher: ReflectionHasher) {}

	async render(events: readonly SemanticEventV2[]): Promise<EvidenceFactV2[]> {
		const facts: EvidenceFactV2[] = [];
		for (const event of events) {
			if (event.countClass === "ignored") continue;
			facts.push(await this.renderEvent(event));
		}
		return facts;
	}

	private async renderEvent(event: SemanticEventV2): Promise<EvidenceFactV2> {
		const rendered = renderTemplate(event);
		const factId = `fact_${await this.hasher.sha256(
			canonicalJson({
				eventIds: [event.eventId],
				templateCode: rendered.templateCode,
				templateArgs: rendered.templateArgs,
				projectorVersion: event.projectorVersion,
			}),
		)}`;
		return {
			schemaVersion: EVIDENCE_FACT_SCHEMA_VERSION,
			factId,
			eventIds: [event.eventId],
			sourceObservationIds: [...event.sourceObservationIds],
			startedAtMs: event.occurredAtMs,
			endedAtMs: event.observedAtMs,
			templateCode: rendered.templateCode,
			templateArgs: rendered.templateArgs,
			renderedText: rendered.text,
			anchor: evidenceAnchor(event),
			role: factRole(event),
			reliability: event.reliability,
			coverage: [...event.coverage],
		};
	}
}

type RenderedTemplate = {
	templateCode: FactTemplateCode;
	templateArgs: Record<string, JsonPrimitive>;
	text: string;
};

function renderTemplate(event: SemanticEventV2): RenderedTemplate {
	const appName = stringValue(event, "appName") ?? stringValue(event, "appId");
	switch (event.kind) {
		case "application.foregroundChanged": {
			const title = contentValue(event, "windowTitle");
			return {
				templateCode: "application.foreground",
				templateArgs: compactArgs({ appName, windowTitle: title }),
				text: title
					? `前台切换到 ${appName ?? "未知应用"}，可见窗口标题为“${title}”`
					: `前台切换到 ${appName ?? "未知应用"}`,
			};
		}
		case "application.visibleContentChanged": {
			const title = contentValue(event, "windowTitle");
			const text = contentValue(event, "visibleText");
			if (text) {
				return {
					templateCode: "application.visible_content",
					templateArgs: compactArgs({
						appName,
						windowTitle: title,
						visibleText: text,
					}),
					text: `${appName ?? "当前应用"}的屏幕可见区域出现“${text}”`,
				};
			}
			return unavailableContentTemplate(
				event,
				`${appName ?? "当前应用"}的可见内容发生变化，但正文不可用`,
				{ appName, windowTitle: title },
			);
		}
		case "application.textValueChanged": {
			const label = contentValue(event, "label");
			const addedText = contentValue(event, "addedText");
			const finalValue = contentValue(event, "finalValue");
			const insertedChars = numberValue(event, "insertedChars") ?? 0;
			const deletedChars = numberValue(event, "deletedChars") ?? 0;
			const control = label ? `“${label}”控件` : "焦点控件";
			const detail = addedText ?? finalValue;
			return {
				templateCode: "application.text_value",
				templateArgs: compactArgs({
					appName,
					label,
					addedText,
					finalValue,
					insertedChars,
					deletedChars,
					inputMethod: "unknown",
				}),
				text: detail
					? `${appName ?? "当前应用"}的${control}最终增加了文本“${detail}”，输入方式未知`
					: `${appName ?? "当前应用"}的${control}最终内容发生变化（增加 ${insertedChars} 字符、删除 ${deletedChars} 字符），输入方式未知`,
			};
		}
		case "browser.visiblePageChanged": {
			const title = contentValue(event, "title");
			const url = sanitizedUrl(contentValue(event, "url"));
			const visibleText = contentValue(event, "visibleText");
			const domain = stringValue(event, "domain");
			const page = title ?? url ?? domain ?? "未知页面";
			const suffix = visibleText
				? `，页面可见区域出现“${visibleText}”`
				: "";
			return {
				templateCode: "browser.visible_page",
				templateArgs: compactArgs({
					appName,
					title,
					url,
					domain,
					visibleText,
					changeKind: stringValue(event, "changeKind"),
				}),
				text: `在${appName ?? "浏览器"}打开或查看当前可见页面“${page}”${suffix}`,
			};
		}
		case "ui.focusChanged": {
			const role = stringValue(event, "role") ?? "未知控件";
			const label = contentValue(event, "label");
			return {
				templateCode: "ui.focus",
				templateArgs: compactArgs({ appName, role, label }),
				text: label
					? `${appName ?? "当前应用"}的焦点切换到 ${role}“${label}”`
					: `${appName ?? "当前应用"}的焦点切换到 ${role}`,
			};
		}
		case "ui.controlActivated": {
			const role = stringValue(event, "role") ?? "未知控件";
			const action = stringValue(event, "action") ?? "activate";
			const label = contentValue(event, "label");
			return {
				templateCode: "ui.control_activated",
				templateArgs: compactArgs({ appName, role, action, label }),
				text: label
					? `在${appName ?? "当前应用"}对 ${role}“${label}”执行了 ${action}`
					: `在${appName ?? "当前应用"}对 ${role} 执行了 ${action}`,
			};
		}
		case "input.activityBucket": {
			const keyCount = numberValue(event, "keyCount") ?? 0;
			const clickCount = numberValue(event, "clickCount") ?? 0;
			const scrollDelta = numberValue(event, "scrollDelta") ?? 0;
			const mouseDistance = numberValue(event, "mouseDistance") ?? 0;
			return {
				templateCode: "input.activity",
				templateArgs: {
					keyCount,
					clickCount,
					scrollDelta,
					mouseDistance: Math.round(mouseDistance),
				},
				text: `5 秒内检测到 ${keyCount} 次键盘活动、${clickCount} 次点击、滚动量 ${round(scrollDelta)} 和鼠标移动距离 ${Math.round(mouseDistance)}；未记录按键内容或坐标`,
			};
		}
		case "presence.changed": {
			const state = stringValue(event, "state") ?? "unknown";
			return {
				templateCode: "presence.changed",
				templateArgs: compactArgs({
					state,
					idleForMs: numberValue(event, "idleForMs"),
				}),
				text: presenceText(state),
			};
		}
		case "goal.changed": {
			const next = recordValue(event, "next");
			const nextText =
				next && typeof next.text === "string"
					? compactText(next.text)
					: null;
			return {
				templateCode: "goal.changed",
				templateArgs: compactArgs({
					goalVersion:
						next && typeof next.version === "number"
							? next.version
							: null,
					goalText: nextText,
				}),
				text: nextText
					? `当前目标切换为“${nextText}”`
					: "当前目标已清除",
			};
		}
		case "application.processObservedBatch":
			throw new Error("Ignored process inventory cannot become EvidenceFact.");
		case "coverage.gap":
			throw new Error("Coverage gaps cannot become EvidenceFact.");
	}
}

function unavailableContentTemplate(
	event: SemanticEventV2,
	text: string,
	args: Record<string, JsonPrimitive | undefined>,
): RenderedTemplate {
	return {
		templateCode: "coverage.unavailable",
		templateArgs: compactArgs({
			...args,
			contentState: event.contentState,
		}),
		text,
	};
}

function evidenceAnchor(event: SemanticEventV2): EvidenceAnchorV2 {
	const appId = stringValue(event, "appId");
	const windowId = stringValue(event, "opaqueWindowId");
	switch (event.kind) {
		case "browser.visiblePageChanged":
			return {
				appId,
				windowId,
				documentId: null,
				pageId:
					stringValue(event, "contentHash") ??
					stringValue(event, "domain"),
			};
		case "application.textValueChanged":
			return {
				appId,
				windowId,
				documentId:
					stringValue(event, "opaqueControlId") ?? windowId,
				pageId: null,
			};
		case "application.visibleContentChanged":
			return {
				appId,
				windowId,
				documentId: stringValue(event, "contentHash"),
				pageId: null,
			};
		default:
			return { appId, windowId, documentId: null, pageId: null };
	}
}

function factRole(
	event: SemanticEventV2,
): EvidenceFactV2["role"] {
	if (event.countClass === "boundary") return "boundary";
	switch (event.kind) {
		case "input.activityBucket":
		case "ui.focusChanged":
			return "supporting";
		default:
			return "primary";
	}
}

function presenceText(state: string): string {
	switch (state) {
		case "afk_started":
			return "用户进入暂离状态";
		case "afk_ended":
			return "用户结束暂离并恢复活动";
		case "locked":
			return "电脑已锁屏";
		case "unlocked":
			return "电脑已解锁";
		case "sleep":
			return "电脑进入睡眠";
		case "wake":
			return "电脑从睡眠中唤醒";
		default:
			return "用户在场状态发生变化";
	}
}

function stringValue(event: SemanticEventV2, key: string): string | null {
	const value = event.payload[key];
	return typeof value === "string" ? compactText(value) : null;
}

function contentValue(event: SemanticEventV2, key: string): string | null {
	if (event.contentState !== "available") return null;
	return stringValue(event, key);
}

function numberValue(event: SemanticEventV2, key: string): number | null {
	const value = event.payload[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function recordValue(
	event: SemanticEventV2,
	key: string,
): Record<string, unknown> | null {
	const value = event.payload[key];
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value
		: null;
}

function compactArgs(
	values: Record<string, JsonPrimitive | undefined>,
): Record<string, JsonPrimitive> {
	const result: Record<string, JsonPrimitive> = {};
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined) continue;
		result[key] =
			typeof value === "string" ? compactText(value) : value;
	}
	return result;
}

function compactText(value: string): string {
	return Array.from(value.replace(/\s+/gu, " ").trim())
		.slice(0, MAX_FACT_CONTENT_CHARACTERS)
		.join("");
}

function sanitizedUrl(value: string | null): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		return compactText(url.toString());
	} catch {
		return compactText(value.split(/[?#]/u, 1)[0] ?? value);
	}
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}

export function mergeCoverage(
	values: readonly (readonly CoverageLevel[])[],
): CoverageLevel[] {
	const order: CoverageLevel[] = [
		"content",
		"metadata",
		"redacted",
		"denied",
		"unavailable",
	];
	const present = new Set(values.flat());
	return order.filter((value) => present.has(value));
}
