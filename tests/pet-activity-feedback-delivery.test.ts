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













});
