import process from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ContentLengthFrameParser } from "./framing";
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
			process.stderr.write(`[agent-host] background failure: ${safeMessage(error)}\n`);
		},
	});
	peer.setRequestHandler((request) => runtime.dispatch(request));

	let inputTail = Promise.resolve();
	process.stdin.on("data", (chunk: Buffer) => {
		inputTail = inputTail
			.then(async () => {
				for (const message of parser.push(chunk)) await peer.accept(message);
			})
			.catch((error) => stopWithFailure(peer, error));
	});
	process.stdin.on("end", () => {
		inputTail = inputTail
			.then(() => parser.finish())
			.catch((error) => stopWithFailure(peer, error))
			.finally(() => peer.close(new Error("Agent host input closed.")));
	});
	process.stdin.on("error", (error) => stopWithFailure(peer, error));
	process.stdin.resume();
}

function stopWithFailure(peer: DuplexProtocolPeer, error: unknown): void {
	const failure = error instanceof Error ? error : new Error(String(error));
	peer.close(failure);
	process.stderr.write(`[agent-host] protocol failure: ${safeMessage(failure)}\n`);
	process.exitCode = 1;
	process.stdin.pause();
}

function safeMessage(error: Error): string {
	return error.message.replace(/[\r\n]+/g, " ").slice(0, 1_000);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) startAgentHost();
