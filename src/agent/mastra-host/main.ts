import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ContentLengthFrameParser } from "./framing";
import {
	isModelRelayEventFrame,
	isProtocolResponse,
	isRecord,
} from "./protocol";
import { AgentHostRuntime } from "./runtime";
import { DuplexProtocolPeer, NodeProtocolWriter } from "./transport";

export function startAgentHost(): void {
	const parser = new ContentLengthFrameParser();
	const writer = new NodeProtocolWriter(process.stdout);
	const peer = new DuplexProtocolPeer(writer);
	const runtime = new AgentHostRuntime(peer, writer, {
		onShutdownRequested: () => {
			process.stdin.destroy();
		},
		onBackgroundError: (error) => {
			process.stderr.write(
				`[agent-host] background failure: ${safeMessage(error)}\n`,
			);
		},
	});
	peer.setRequestHandler((request) => runtime.dispatch(request));

	// Requests from Bun remain ordered, but responses to a Sidecar-initiated
	// host call must bypass that queue. A workflow can legitimately make such a
	// call before its originating request has completed; queueing its response
	// behind the originating request would deadlock this duplex protocol.
	let requestTail = Promise.resolve();
	process.stdin.on("data", (chunk: Buffer) => {
		let messages: unknown[];
		try {
			messages = parser.push(chunk);
		} catch (error) {
			stopWithFailure(peer, error);
			return;
		}
		for (const message of messages) {
			if (isProtocolResponse(message) || isModelRelayEventFrame(message)) {
				void peer
					.accept(message)
					.catch((error) => stopWithFailure(peer, error));
				continue;
			}
			// A response bypasses the ordered request queue. Never let a malformed
			// response fall through to that queue: it would be treated as a request
			// and could leave the matching Sidecar pending forever.
			if (
				isRecord(message) &&
				(message.type === "response" || message.type === "event")
			) {
				stopWithFailure(
					peer,
					new Error("Agent host received an invalid protocol frame."),
				);
				return;
			}
			requestTail = requestTail.then(() => peer.accept(message));
			void requestTail.catch((error) => stopWithFailure(peer, error));
		}
	});
	process.stdin.on("end", () => {
		requestTail = requestTail
			.then(() => parser.finish())
			.finally(() => peer.close(new Error("Agent host input closed.")));
		void requestTail.catch((error) => stopWithFailure(peer, error));
	});
	process.stdin.on("error", (error) => stopWithFailure(peer, error));
	process.stdin.resume();
}

function stopWithFailure(peer: DuplexProtocolPeer, error: unknown): void {
	const failure = error instanceof Error ? error : new Error(String(error));
	peer.close(failure);
	process.stderr.write(
		`[agent-host] protocol failure: ${safeMessage(failure)}\n`,
	);
	process.exitCode = 1;
	process.stdin.destroy();
	setImmediate(() => process.exit(1));
}

function safeMessage(error: Error): string {
	return error.message.replace(/[\r\n]+/g, " ").slice(0, 1_000);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath)
	startAgentHost();
