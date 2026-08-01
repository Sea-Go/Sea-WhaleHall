import { describe, expect, test } from "bun:test";
import {
	ContentLengthFrameParser,
	ContentLengthProtocolError,
	DEFAULT_MAX_FRAME_BYTES,
	encodeContentLengthFrame,
} from "../src/agent/mastra-host/framing";
import {
	AGENT_HOST_PROTOCOL_VERSION,
	isAgentRunEventFrame,
	isSidecarHostRequest,
} from "../src/agent/mastra-host/protocol";
import { safeSidecarEnvironment } from "../src/bun/mastra-sidecar-client";

describe("Mastra sidecar Content-Length framing", () => {
	test("uses UTF-8 byte lengths and accepts arbitrarily fragmented input", () => {
		const value = { text: "鲸落，让每个字节都被准确计数。", nested: { ok: true } };
		const frame = encodeContentLengthFrame(value);
		const parser = new ContentLengthFrameParser();
		const decoded: unknown[] = [];
		for (const byte of frame) decoded.push(...parser.push(Uint8Array.of(byte)));
		parser.finish();
		expect(decoded).toEqual([value]);
		const header = frame.subarray(0, frame.indexOf("\r\n\r\n")).toString("ascii");
		expect(header).toBe(`Content-Length: ${Buffer.byteLength(JSON.stringify(value))}`);
	});

	test("parses multiple coalesced frames in order", () => {
		const parser = new ContentLengthFrameParser();
		const bytes = Buffer.concat([
			encodeContentLengthFrame({ id: 1 }),
			encodeContentLengthFrame({ id: 2 }),
			encodeContentLengthFrame({ id: 3 }),
		]);
		expect(parser.push(bytes)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
		parser.finish();
	});

	test("bounds frames at 16 MiB and rejects malformed headers", () => {
		expect(DEFAULT_MAX_FRAME_BYTES).toBe(16 * 1024 * 1024);
		const duplicate = Buffer.from(
			"Content-Length: 2\r\ncontent-length: 2\r\n\r\n{}",
			"utf8",
		);
		expect(() => new ContentLengthFrameParser().push(duplicate)).toThrow(
			ContentLengthProtocolError,
		);
		expect(() =>
			new ContentLengthFrameParser(4).push(
				Buffer.from("Content-Length: 5\r\n\r\n12345", "ascii"),
			),
		).toThrow("exceeds 4 bytes");
		expect(() =>
			new ContentLengthFrameParser().push(Buffer.from("X-Test: 1\r\n\r\n{}", "ascii")),
		).toThrow("missing a Content-Length");
	});

	test("rejects incomplete bodies at end of input", () => {
		const parser = new ContentLengthFrameParser();
		parser.push(Buffer.from("Content-Length: 4\r\n\r\n{}", "ascii"));
		expect(() => parser.finish()).toThrow("incomplete frame");
	});

	test("validates Sidecar host methods and complete run-event envelopes", () => {
		expect(isSidecarHostRequest({
			protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
			type: "request",
			requestId: "host-1",
			method: "workflow/snapshot.update-state",
			params: { workflowName: "task-planning" },
		})).toBe(true);
		expect(isSidecarHostRequest({
			protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
			type: "request",
			requestId: "host-2",
			method: "system/open-shell",
			params: {},
		})).toBe(false);

		const completed = {
			protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
			type: "event",
			requestId: "request-1",
			runId: "run-1",
			sequence: 3,
			version: 3,
			emittedAtMs: 10,
			terminalState: "completed",
			event: { kind: "run.completed", result: { answer: "ok" } },
		};
		expect(isAgentRunEventFrame(completed)).toBe(true);
		expect(isAgentRunEventFrame({ ...completed, sequence: 0 })).toBe(false);
		expect(isAgentRunEventFrame({ ...completed, terminalState: null })).toBe(false);
		expect(isAgentRunEventFrame({
			...completed,
			terminalState: null,
			event: { kind: "agent.tool.call", toolCallId: "tool-1" },
		})).toBe(false);
	});

	test("disables Mastra telemetry and does not pass provider credentials to the Sidecar", () => {
		const environment = safeSidecarEnvironment();
		expect(environment.MASTRA_TELEMETRY_DISABLED).toBe("1");
		expect(environment).not.toHaveProperty("OPENAI_API_KEY");
		expect(environment).not.toHaveProperty("WHALEHALL_AGENT_API_TOKEN");
		expect(environment).not.toHaveProperty("WHALEHALL_RELAY_URL");
	});
});
