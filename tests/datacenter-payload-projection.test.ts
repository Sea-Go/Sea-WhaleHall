import { describe, expect, test } from "bun:test";
import {
	formatDesktopCursor,
	isContiguousCursors,
	parseDesktopCursor,
	projectMetadataPayload,
} from "../src/bun/datacenter/payload-projection";

describe("DataCenter metadata payload projection", () => {
	test("strips sensitive extra fields from application.foregroundChanged", () => {
		const result = projectMetadataPayload("application.foregroundChanged", {
			appId: "com.example.app",
			appName: "Example",
			windowTitle: "Secret document title",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.payload).toEqual({
			appId: "com.example.app",
			appName: "Example",
		});
	});

	test("drops relativePath from editor.documentChanged while keeping counts", () => {
		const result = projectMetadataPayload("editor.documentChanged", {
			editorId: "vscode",
			documentId: "doc-1",
			insertedChars: 12,
			deletedChars: 3,
			burstStartedAtMs: 100,
			burstEndedAtMs: 200,
			language: "typescript",
			relativePath: "/fixtures/private/secret.ts",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.payload).toEqual({
			editorId: "vscode",
			documentId: "doc-1",
			insertedChars: 12,
			deletedChars: 3,
			burstStartedAtMs: 100,
			burstEndedAtMs: 200,
			language: "typescript",
		});
	});

	test("rejects editor bursts where the end precedes the start", () => {
		const result = projectMetadataPayload("editor.documentChanged", {
			editorId: "vscode",
			documentId: "doc-1",
			insertedChars: 1,
			deletedChars: 0,
			burstStartedAtMs: 200,
			burstEndedAtMs: 100,
		});
		expect(result.ok).toBe(false);
	});

	test("rejects a required-field gap", () => {
		const result = projectMetadataPayload("input.activityAggregated", {
			bucketStartedAtMs: 0,
			bucketEndedAtMs: 100,
			keyCount: 2,
		});
		expect(result.ok).toBe(false);
	});

	test("rejects unknown kinds and goal.contextChanged content", () => {
		expect(projectMetadataPayload("goal.contextChanged", {}).ok).toBe(false);
		expect(projectMetadataPayload("unknown.kind", {}).ok).toBe(false);
	});

	test("accepts empty-payload system and presence events", () => {
		expect(projectMetadataPayload("system.heartbeat", {}).ok).toBe(true);
		expect(projectMetadataPayload("presence.locked", {}).ok).toBe(true);
	});

	test("drops invalid optional values instead of failing the event", () => {
		const result = projectMetadataPayload("editor.documentChanged", {
			editorId: "vscode",
			documentId: "doc-1",
			insertedChars: 1,
			deletedChars: 0,
			burstStartedAtMs: 0,
			burstEndedAtMs: 10,
			language: 42,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect("language" in result.payload).toBe(false);
	});
});

describe("DataCenter desktop cursors", () => {
	test("parses and formats ec1_ cursors round-trip", () => {
		expect(parseDesktopCursor("ec1_0000000000000001")).toBe(1);
		expect(formatDesktopCursor(1)).toBe("ec1_0000000000000001");
		expect(parseDesktopCursor("not-a-cursor")).toBeNull();
	});

	test("detects contiguous and gapped cursor runs", () => {
		expect(
			isContiguousCursors([
				"ec1_0000000000000001",
				"ec1_0000000000000002",
				"ec1_0000000000000003",
			]),
		).toBe(true);
		expect(
			isContiguousCursors([
				"ec1_0000000000000001",
				"ec1_0000000000000003",
			]),
		).toBe(false);
	});
});
