import { describe, expect, test } from "bun:test";
import { PetActivityFeedbackDelivery } from "../src/bun/pet-activity-feedback-delivery";
import type { PetActivityFeedbackPresentation } from "../src/shared/pet-activity-feedback";

const feedback: PetActivityFeedbackPresentation = {
	presentationId: "feedback-1",
	generatedAtMs: 1_786_464_000_000,
	text: "你已经连续推进当前目标一段时间，可以确认下一步。",
};

function readyRenderer(delivery: PetActivityFeedbackDelivery): string {
	delivery.beginRendererLoad();
	const rendererEpoch = delivery.markRendererNavigationCommitted();
	expect(rendererEpoch).not.toBeNull();
	delivery.markRendererDocumentReady();
	expect(delivery.markRendererReady({ rendererEpoch })).toBeTrue();
	return rendererEpoch as string;
}

describe("pet activity feedback delivery gate", () => {
	test("drops hidden and unready feedback without replaying it later", async () => {
		const presented: PetActivityFeedbackPresentation[] = [];
		const delivery = new PetActivityFeedbackDelivery({
			present: (presentation) => presented.push(presentation),
			clear: ({ clearId }) => ({ clearId, cleared: true }),
			failClosedAfterClearFailure: () => {},
		});

		expect(delivery.present(feedback)).toBe(false);
		readyRenderer(delivery);
		await delivery.setVisible(false);
		expect(delivery.present(feedback)).toBe(false);
		await delivery.setVisible(true);
		expect(presented).toEqual([]);
		expect(delivery.present(feedback)).toBe(true);
		expect(presented).toEqual([feedback]);
		expect(delivery.present(feedback)).toBe(false);
		expect(presented).toEqual([feedback]);

		delivery.markRendererUnavailable();
		expect(
			delivery.present({ ...feedback, presentationId: "feedback-2" }),
		).toBe(false);
		readyRenderer(delivery);
		expect(presented).toEqual([feedback]);
	});

	test("visibility, account transition, and disposal clear only live memory", async () => {
		let clears = 0;
		const delivery = new PetActivityFeedbackDelivery({
			present: () => {},
			clear: ({ clearId }) => {
				clears += 1;
				return { clearId, cleared: true };
			},
			failClosedAfterClearFailure: () => {},
		});
		readyRenderer(delivery);
		await delivery.clearForAccountTransition();
		await delivery.setVisible(false);
		delivery.dispose();
		expect(clears).toBe(3);
		expect(delivery.present(feedback)).toBe(false);
	});

	test("clears a hidden renderer before it can be shown for another account", async () => {
		let clears = 0;
		const delivery = new PetActivityFeedbackDelivery({
			present: () => {},
			clear: ({ clearId }) => {
				clears += 1;
				return { clearId, cleared: true };
			},
			failClosedAfterClearFailure: () => {},
		});
		readyRenderer(delivery);
		await delivery.setVisible(false);
		await delivery.clearForAccountTransition();
		await delivery.setVisible(true);
		expect(clears).toBe(2);
	});

	test("account clearing does not reset process-level presentation dedupe", async () => {
		const presented: string[] = [];
		const delivery = new PetActivityFeedbackDelivery({
			present: ({ presentationId }) => presented.push(presentationId),
			clear: ({ clearId }) => ({ clearId, cleared: true }),
			failClosedAfterClearFailure: () => {},
		});
		readyRenderer(delivery);
		expect(delivery.present(feedback)).toBe(true);
		await delivery.clearForAccountTransition();
		expect(delivery.present(feedback)).toBe(false);
		expect(presented).toEqual([feedback.presentationId]);
	});

	test("rebuilds an unready renderer before the next account can show it", async () => {
		let fallbackCalls = 0;
		const delivery = new PetActivityFeedbackDelivery({
			present: () => {},
			clear: ({ clearId }) => ({ clearId, cleared: true }),
			failClosedAfterClearFailure: () => {
				fallbackCalls += 1;
			},
		});
		await delivery.clearForAccountTransition();
		expect(fallbackCalls).toBe(1);
		expect(delivery.present(feedback)).toBe(false);
	});

	test("rejects late ready from a renderer superseded by a reload epoch", () => {
		let epoch = 0;
		const delivery = new PetActivityFeedbackDelivery({
			present: () => {},
			clear: ({ clearId }) => ({ clearId, cleared: true }),
			failClosedAfterClearFailure: () => {},
			createRendererEpoch: () => `renderer-${++epoch}`,
		});
		const staleEpoch = delivery.beginRendererLoad();
		expect(delivery.beginRendererLoad()).toBe(staleEpoch);
		expect(
			delivery.markRendererReady({ rendererEpoch: staleEpoch }),
		).toBeFalse();
		expect(delivery.present(feedback)).toBeFalse();
		const currentEpoch = delivery.markRendererNavigationCommitted();
		delivery.markRendererDocumentReady();
		expect(
			delivery.markRendererReady({ rendererEpoch: currentEpoch }),
		).toBeTrue();
		expect(delivery.present(feedback)).toBeTrue();
	});

	test("rejects invalid content and never lets transport failure escape", async () => {
		let attempts = 0;
		const delivery = new PetActivityFeedbackDelivery({
			present: () => {
				attempts += 1;
				if (attempts === 1)
					throw new Error("sensitive output must not be logged");
				return Promise.reject(new Error("renderer unavailable"));
			},
			clear: () => Promise.reject(new Error("renderer unavailable")),
			failClosedAfterClearFailure: () => {},
		});
		readyRenderer(delivery);
		expect(delivery.present(feedback)).toBe(false);
		expect(
			delivery.present({ ...feedback, presentationId: "feedback-async" }),
		).toBe(true);
		expect(delivery.present({ ...feedback, text: "unsafe\u0000content" })).toBe(
			false,
		);
		await delivery.clearForAccountTransition();
		await Promise.resolve();
		expect(attempts).toBe(2);
	});

	test("awaits the exact clear acknowledgement before an account handoff", async () => {
		let resolveClear!: () => void;
		const delivery = new PetActivityFeedbackDelivery({
			present: () => {},
			clear: ({ clearId }) =>
				new Promise((resolve) => {
					resolveClear = () => resolve({ clearId, cleared: true });
				}),
			failClosedAfterClearFailure: () => {},
		});
		readyRenderer(delivery);
		let settled = false;
		const barrier = delivery.clearForAccountTransition().then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		resolveClear();
		await barrier;
		expect(settled).toBe(true);
	});

	test("hides fail closed when the renderer cannot acknowledge a clear", async () => {
		let fallbackCalls = 0;
		const delivery = new PetActivityFeedbackDelivery({
			present: () => {},
			clear: () => Promise.reject(new Error("renderer unavailable")),
			failClosedAfterClearFailure: () => {
				fallbackCalls += 1;
			},
		});
		readyRenderer(delivery);
		await delivery.clearForAccountTransition();
		expect(fallbackCalls).toBe(1);
		expect(delivery.present(feedback)).toBe(false);
	});

	test("rejects a stale clear acknowledgement before the next account", async () => {
		let fallbackCalls = 0;
		const delivery = new PetActivityFeedbackDelivery({
			present: () => {},
			clear: () => ({ clearId: "stale-clear", cleared: true }),
			failClosedAfterClearFailure: () => {
				fallbackCalls += 1;
			},
			createClearId: () => "current-clear",
		});
		readyRenderer(delivery);
		await delivery.clearForAccountTransition();
		expect(fallbackCalls).toBe(1);
		expect(delivery.present(feedback)).toBe(false);
	});

	test("authorizes only the exact document challenge after DOM readiness", () => {
		let epoch = 0;
		const delivery = new PetActivityFeedbackDelivery({
			present: () => {},
			clear: ({ clearId }) => ({ clearId, cleared: true }),
			failClosedAfterClearFailure: () => {},
			createRendererEpoch: () => `renderer-${++epoch}`,
		});
		const pending = delivery.beginRendererLoad();
		expect(delivery.rendererChallenge()).toBeNull();
		expect(delivery.markRendererReady({ rendererEpoch: pending })).toBeFalse();
		expect(delivery.markRendererDocumentReady()).toBeNull();
		const first = delivery.markRendererNavigationCommitted();
		if (first === null) throw new Error("renderer commit was not recorded");
		expect(delivery.markRendererDocumentReady()).toEqual({
			rendererEpoch: first,
		});
		expect(delivery.markRendererReady({ rendererEpoch: first })).toBeTrue();

		delivery.markRendererNavigationCommitted();
		const second = delivery.markRendererDocumentReady();
		expect(second).toEqual({ rendererEpoch: "renderer-4" });
		expect(delivery.markRendererReady({ rendererEpoch: first })).toBeFalse();
		expect(delivery.markRendererReady(second)).toBeTrue();
	});

	test("keeps a pending reload single-flight across repeated account clears", async () => {
		const reloads: boolean[] = [];
		const delivery = new PetActivityFeedbackDelivery({
			present: () => {},
			clear: () => Promise.reject(new Error("renderer unavailable")),
			failClosedAfterClearFailure: ({ reloadRequired }) => {
				reloads.push(reloadRequired);
			},
		});
		readyRenderer(delivery);
		await delivery.clearForAccountTransition();
		await delivery.clearForAccountTransition();
		expect(reloads).toEqual([true, false]);
	});

	test("does not let the old document prove a pending reload before commit", async () => {
		let epoch = 0;
		const delivery = new PetActivityFeedbackDelivery({
			present: () => {},
			clear: () => Promise.reject(new Error("renderer unavailable")),
			failClosedAfterClearFailure: () => {},
			createRendererEpoch: () => `renderer-${++epoch}`,
		});
		readyRenderer(delivery);
		await delivery.clearForAccountTransition();
		expect(delivery.markRendererDocumentReady()).toBeNull();
		expect(
			delivery.markRendererReady({ rendererEpoch: "renderer-3" }),
		).toBeFalse();
		delivery.markRendererNavigationCommitted();
		expect(delivery.markRendererDocumentReady()).toEqual({
			rendererEpoch: "renderer-4",
		});
		expect(
			delivery.markRendererReady({ rendererEpoch: "renderer-4" }),
		).toBeTrue();
	});

	test("rejects a proof response issued by the previous native commit", () => {
		let epoch = 0;
		const delivery = new PetActivityFeedbackDelivery({
			present: () => {},
			clear: ({ clearId }) => ({ clearId, cleared: true }),
			failClosedAfterClearFailure: () => {},
			createRendererEpoch: () => `renderer-${++epoch}`,
		});
		delivery.beginRendererLoad();
		delivery.markRendererNavigationCommitted();
		const firstDocument = delivery.markRendererDocumentReady();
		delivery.markRendererNavigationCommitted();
		const secondDocument = delivery.markRendererDocumentReady();
		expect(delivery.markRendererReady(firstDocument)).toBeFalse();
		expect(delivery.markRendererReady(secondDocument)).toBeTrue();
	});

	test("ignores a stale clear failure after a successor renderer is accepted", async () => {
		let rejectFirst!: (error: Error) => void;
		let clearCalls = 0;
		let fallbackCalls = 0;
		const delivery = new PetActivityFeedbackDelivery({
			present: () => {},
			clear: () => {
				clearCalls += 1;
				if (clearCalls === 1) {
					return new Promise((_, reject) => {
						rejectFirst = reject;
					});
				}
				return Promise.reject(new Error("renderer unavailable"));
			},
			failClosedAfterClearFailure: () => {
				fallbackCalls += 1;
			},
		});
		readyRenderer(delivery);
		const staleClear = delivery.clearForAccountTransition();
		await Promise.resolve();
		await delivery.clearForAccountTransition();
		readyRenderer(delivery);
		rejectFirst(new Error("late old-renderer failure"));
		await staleClear;
		expect(fallbackCalls).toBe(1);
		expect(delivery.present(feedback)).toBeTrue();
	});
});
