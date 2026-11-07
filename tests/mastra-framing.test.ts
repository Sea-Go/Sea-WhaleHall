import { describe, expect, test } from "bun:test";
import {
	ContentLengthFrameParser,
	ContentLengthProtocolError,
	DEFAULT_MAX_FRAME_BYTES,
	encodeContentLengthFrame,
} from "../src/agent/mastra-host/framing";
import {
	AGENT_HOST_PROTOCOL_VERSION,
	isAgentHostRequest,
	isAgentRunEventFrame,
	isSidecarHostRequest,
} from "../src/agent/mastra-host/protocol";
import { safeSidecarEnvironment } from "../src/bun/mastra-sidecar-client";

describe("Mastra sidecar Content-Length framing", () => {
	test("pins required model Agent identity to protocol v5", () => {
		expect(AGENT_HOST_PROTOCOL_VERSION).toBe(5);
		expect(
			isAgentHostRequest({
				protocolVersion: 2,
				type: "request",
				requestId: "legacy-initialize",
				method: "runtime.initialize",
				params: {},
			}),
		).toBe(false);
	});

	test("uses UTF-8 byte lengths and accepts arbitrarily fragmented input", () => {
		const value = {
			text: "鲸落，让每个字节都被准确计数。",
			nested: { ok: true },
		};
		const frame = encodeContentLengthFrame(value);
		const parser = new ContentLengthFrameParser();
		const decoded: unknown[] = [];
		for (const byte of frame) decoded.push(...parser.push(Uint8Array.of(byte)));
		parser.finish();
		expect(decoded).toEqual([value]);
		const header = frame
			.subarray(0, frame.indexOf("\r\n\r\n"))
			.toString("ascii");
		expect(header).toBe(
			`Content-Length: ${Buffer.byteLength(JSON.stringify(value))}`,
		);
	});
});
