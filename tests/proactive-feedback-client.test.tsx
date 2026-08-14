import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
	ProactiveFeedbackAvailable,
	ProactiveFeedbackHistoryCursor,
	ProactiveFeedbackItem,
	ProactiveFeedbackPage,
	ProactiveFeedbackPolicy,
	ProactiveFeedbackPolicySnapshot,
} from "../src/shared/proactive-feedback";
import {
	formatProactiveFeedbackTime,
	groupProactiveFeedbackByLocalDay,
} from "../src/views/client/features/proactive-feedback/domain";
import { ProactiveFeedbackHistoryController } from "../src/views/client/features/proactive-feedback/ProactiveFeedbackHistoryController";
import { ProactiveFeedbackHistoryPage } from "../src/views/client/features/proactive-feedback/ProactiveFeedbackHistoryPage";
import { ProactiveFeedbackPolicyControl } from "../src/views/client/features/proactive-feedback/ProactiveFeedbackPolicyControl";
import { ProactiveFeedbackPolicyController } from "../src/views/client/features/proactive-feedback/ProactiveFeedbackPolicyController";
import {
	type ProactiveFeedbackService,
	ProactiveFeedbackServiceError,
} from "../src/views/client/features/proactive-feedback/proactive-feedback-service";

class TestProactiveFeedbackService implements ProactiveFeedbackService {
	policy: ProactiveFeedbackPolicySnapshot = {
		policy: { enabled: true, retention: 30 },
		revision: 0,
		updatedAtMs: null,
	};
	pages: ProactiveFeedbackPage[] = [];
	listInputs: Array<{
		cursor?: ProactiveFeedbackHistoryCursor;
		limit: number;
	}> = [];
	listFailure: unknown = null;
	nextListPromise: Promise<ProactiveFeedbackPage> | null = null;
	saveFailure: unknown = null;
	clearFailure: unknown = null;
	clearCount = 0;
	private readonly listeners = new Set<
		(event: ProactiveFeedbackAvailable) => void
	>();

	async loadPolicy() {
		return clonePolicy(this.policy);
	}

	async setPolicy(policy: ProactiveFeedbackPolicy, expectedRevision: number) {
		if (this.saveFailure) throw this.saveFailure;
		if (expectedRevision !== this.policy.revision) {
			throw new ProactiveFeedbackServiceError("version-conflict", "conflict");
		}
		this.policy = {
			policy: { ...policy },
			revision: this.policy.revision + 1,
			updatedAtMs: 1_800_000_000_000,
		};
		return clonePolicy(this.policy);
	}

	async listHistory(input: {
		cursor?: ProactiveFeedbackHistoryCursor;
		limit: number;
	}) {
		this.listInputs.push(
			input.cursor
				? { cursor: { ...input.cursor }, limit: input.limit }
				: { limit: input.limit },
		);
		if (this.listFailure) throw this.listFailure;
		if (this.nextListPromise) {
			const request = this.nextListPromise;
			this.nextListPromise = null;
			return request;
		}
		return this.pages.shift() ?? { items: [], nextCursor: null };
	}

	async clear() {
		if (this.clearFailure) throw this.clearFailure;
		this.clearCount += 1;
		return { clearedAtMs: 1_800_000_000_100 };
	}

	onAvailable(listener: (event: ProactiveFeedbackAvailable) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emitAvailable(event: ProactiveFeedbackAvailable) {
		for (const listener of this.listeners) listener(event);
	}
}

const newestItem: ProactiveFeedbackItem = {
	id: "feedback-2",
	generatedAtMs: Date.UTC(2026, 7, 12, 9, 30),
	message: "先完成当前计划，再休息十分钟。",
};
const olderItem: ProactiveFeedbackItem = {
	id: "feedback-1",
	generatedAtMs: Date.UTC(2026, 7, 11, 8, 15),
	message: "昨天的目标推进稳定。",
};
const firstPageItems = [newestItem, olderItem] as const;

describe("proactive feedback history", () => {
	test("loads 20 records at a time and appends keyset pages without duplicates", async () => {
		const service = new TestProactiveFeedbackService();
		const cursor = {
			generatedAtMs: olderItem.generatedAtMs,
			id: olderItem.id,
		};
		service.pages = [
			{ items: firstPageItems, nextCursor: cursor },
			{
				items: [
					olderItem,
					{
						id: "feedback-0",
						generatedAtMs: Date.UTC(2026, 7, 10, 7),
						message: "更早的反馈。",
					},
				],
				nextCursor: null,
			},
		];
		const controller = new ProactiveFeedbackHistoryController(service);
		await controller.load();
		expect(service.listInputs).toEqual([{ limit: 20 }]);
		await controller.loadMore();
		expect(service.listInputs[1]).toEqual({ cursor, limit: 20 });
		const state = controller.getSnapshot();
		expect(state.status).toBe("ready");
		if (!("items" in state)) throw new Error("Expected history items");
		expect(state.items.map((item) => item.id)).toEqual([
			"feedback-2",
			"feedback-1",
			"feedback-0",
		]);
		controller.dispose();
	});

	test("refreshes only while visible when a content-free availability event arrives", async () => {
		const service = new TestProactiveFeedbackService();
		service.pages = [
			{ items: [], nextCursor: null },
			{ items: firstPageItems, nextCursor: null },
		];
		const controller = new ProactiveFeedbackHistoryController(service);
		await controller.load();
		service.emitAvailable({
			id: "feedback-2",
			generatedAtMs: newestItem.generatedAtMs,
		});
		expect(service.listInputs).toHaveLength(1);
		controller.setVisible(true);
		await waitFor(() => service.listInputs.length === 2);
		expect(controller.getSnapshot().status).toBe("ready");
		controller.dispose();
	});

	test("does not lose an availability event that arrives during an in-flight refresh", async () => {
		const service = new TestProactiveFeedbackService();
		let resolveFirst: (page: ProactiveFeedbackPage) => void = () => {};
		service.nextListPromise = new Promise((resolve) => {
			resolveFirst = resolve;
		});
		service.pages = [{ items: firstPageItems, nextCursor: null }];
		const controller = new ProactiveFeedbackHistoryController(service);
		controller.setVisible(true);
		expect(service.listInputs).toHaveLength(1);
		service.emitAvailable({
			id: newestItem.id,
			generatedAtMs: newestItem.generatedAtMs,
		});
		resolveFirst({ items: [], nextCursor: null });
		await waitFor(() => service.listInputs.length === 2);
		await waitFor(() => controller.getSnapshot().status === "ready");
		controller.dispose();
	});

	test("keeps loaded rows visible when loading an earlier page fails", async () => {
		const service = new TestProactiveFeedbackService();
		service.pages = [
			{
				items: firstPageItems,
				nextCursor: {
					generatedAtMs: olderItem.generatedAtMs,
					id: olderItem.id,
				},
			},
		];
		const controller = new ProactiveFeedbackHistoryController(service);
		await controller.load();
		service.listFailure = new ProactiveFeedbackServiceError(
			"offline",
			"offline",
		);
		await controller.loadMore();
		const state = controller.getSnapshot();
		expect(state).toMatchObject({ status: "error", stage: "more" });
		if (!("items" in state)) throw new Error("Expected retained rows");
		expect(state.items).toHaveLength(2);
		controller.dispose();
	});

	test("does not restore stale rows after a clear wins an in-flight load race", async () => {
		const service = new TestProactiveFeedbackService();
		let resolveLoad: (page: ProactiveFeedbackPage) => void = () => {};
		service.nextListPromise = new Promise((resolve) => {
			resolveLoad = resolve;
		});
		const controller = new ProactiveFeedbackHistoryController(service);
		const request = controller.load();
		controller.notifyCleared();
		resolveLoad({ items: firstPageItems, nextCursor: null });
		await request;
		expect(controller.getSnapshot()).toEqual({ status: "empty" });
		controller.dispose();
	});

	test("groups by local day and renders time plus plain final messages without a composer", async () => {
		const groups = groupProactiveFeedbackByLocalDay(firstPageItems, {
			timeZone: "Asia/Shanghai",
		});
		expect(groups).toHaveLength(2);
		expect(
			formatProactiveFeedbackTime(newestItem.generatedAtMs, {
				timeZone: "Asia/Shanghai",
			}),
		).toBe("17:30");

		const service = new TestProactiveFeedbackService();
		service.pages = [
			{
				items: [
					{
						...newestItem,
						message: `**Markdown 保持原文**<b>纯文本</b>${"长内容".repeat(180)}`,
					},
				],
				nextCursor: null,
			},
		];
		const controller = new ProactiveFeedbackHistoryController(service);
		await controller.load();
		const markup = renderToStaticMarkup(
			<ProactiveFeedbackHistoryPage controller={controller} />,
		);
		expect(markup).toContain("历史记录");
		expect(markup).toContain("**Markdown 保持原文**");
		expect(markup).not.toContain("<strong>Markdown 保持原文</strong>");
		expect(markup).toContain("&lt;b&gt;纯文本&lt;/b&gt;");
		expect(markup).toContain("展开全文");
		expect(markup).not.toContain("conversation-draft");
		expect(markup).not.toContain("发送消息");
		controller.dispose();
	});
});

describe("proactive feedback policy", () => {
	test("loads authoritative enabled/30 defaults and persists every retention option", async () => {
		const service = new TestProactiveFeedbackService();
		const controller = new ProactiveFeedbackPolicyController(service);
		await controller.load();
		expect(controller.getSnapshot()).toMatchObject({
			status: "ready",
			snapshot: { policy: { enabled: true, retention: 30 }, revision: 0 },
		});
		await controller.setRetention(7);
		await controller.setRetention(90);
		await controller.setRetention("forever");
		await controller.setRetention(30);
		expect(service.policy.policy).toEqual({ enabled: true, retention: 30 });
		expect(service.policy.revision).toBe(4);
	});

	test("rolls back a failed policy change and keeps the service snapshot authoritative", async () => {
		const service = new TestProactiveFeedbackService();
		const controller = new ProactiveFeedbackPolicyController(service);
		await controller.load();
		service.saveFailure = new ProactiveFeedbackServiceError(
			"offline",
			"offline",
		);
		expect(await controller.setEnabled(false)).toBeNull();
		expect(controller.getSnapshot()).toMatchObject({
			status: "error",
			stage: "save",
			snapshot: { policy: { enabled: true, retention: 30 } },
		});
	});

	test("clears through the authoritative service and renders explicit remote disclosure", async () => {
		const service = new TestProactiveFeedbackService();
		const controller = new ProactiveFeedbackPolicyController(service);
		await controller.load();
		expect(await controller.clear()).toBe(true);
		expect(service.clearCount).toBe(1);
		const markup = renderToStaticMarkup(
			<ProactiveFeedbackPolicyControl controller={controller} />,
		);
		expect(markup).toContain("窗口标题、URL、文件路径、文本");
		expect(markup).toContain("独立于 CloudSync");
		expect(markup).toContain("约保留 30 天");
		expect(markup).toContain("不会删除 DataCenter 审计");
	});
});

function clonePolicy(
	snapshot: ProactiveFeedbackPolicySnapshot,
): ProactiveFeedbackPolicySnapshot {
	return { ...snapshot, policy: { ...snapshot.policy } };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("Condition was not met");
}
