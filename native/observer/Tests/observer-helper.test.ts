import { afterEach, expect, test } from "bun:test";
import { resolve } from "node:path";
import { buildObserverApp } from "../../../scripts/build-native";

type ObserverFrame = {
	type: string;
	schemaVersion: string;
	bootId: string;
	sequence?: number;
	ok?: boolean;
	id?: string;
	capabilities?: Record<string, boolean>;
	observation?: {
		schemaVersion: string;
		kind: string;
		content?: Record<string, unknown>;
	};
};

class FrameReader {
	private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
	private readonly decoder = new TextDecoder();
	private buffered = "";

	constructor(stream: ReadableStream<Uint8Array>) {
		this.reader = stream.getReader();
	}

	async next(timeoutMs = 5_000): Promise<ObserverFrame> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const newline = this.buffered.indexOf("\n");
			if (newline >= 0) {
				const line = this.buffered.slice(0, newline);
				this.buffered = this.buffered.slice(newline + 1);
				if (line.length > 0) return JSON.parse(line) as ObserverFrame;
			}
			const remaining = Math.max(1, deadline - Date.now());
			const result = await Promise.race([
				this.reader.read(),
				Bun.sleep(remaining).then(() => ({ done: true as const, value: undefined })),
			]);
			if (result.done) break;
			this.buffered += this.decoder.decode(result.value, { stream: true });
		}
		throw new Error("Timed out waiting for a WhaleHall Observer frame.");
	}
}

let runningChild: ReturnType<typeof Bun.spawn> | undefined;

afterEach(() => {
	runningChild?.kill();
	runningChild = undefined;
});

const macOSTest = process.platform === "darwin" ? test : test.skip;

macOSTest(
	"builds the bundled helper and exchanges privacy-safe JSONL frames",
	async () => {
		const architecture = process.arch === "arm64" ? "arm64" : "x64";
		const bundle = buildObserverApp(architecture);
		const executable = resolve(
			bundle,
			"Contents/MacOS/whalehall-observer",
		);
		const child = Bun.spawn([executable], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		runningChild = child;
		const frames = new FrameReader(child.stdout);
		const ready = await frames.next();
		expect(ready.type).toBe("ready");
		expect(ready.schemaVersion).toBe("observer-frame.v1");
		expect(ready.capabilities?.storesScreenshots).toBe(false);
		expect(ready.capabilities?.readsKeyValues).toBe(false);

		child.stdin.write(
			`${JSON.stringify({
				type: "command",
				id: "start-1",
				command: "start",
				config: { captureContent: false, excludedBundleIds: [] },
			})}\n`,
		);
		child.stdin.flush();

		let observation: ObserverFrame | undefined;
		let startResult: ObserverFrame | undefined;
		for (let index = 0; index < 8 && (!observation || !startResult); index += 1) {
			const frame = await frames.next();
			if (frame.type === "observation") observation = frame;
			if (frame.type === "commandResult" && frame.id === "start-1") {
				startResult = frame;
			}
		}
		expect(startResult?.ok).toBe(true);
		expect(observation?.observation?.schemaVersion).toBe("raw-observation.v2");
		// A locked/non-interactive macOS session must fail closed with an
		// explicit coverage gap. An unlocked session reports the foreground
		// workspace observation. Both are valid privacy-safe startup outcomes.
		expect([
			"workspace.foregroundChanged",
			"coverage.gap",
		]).toContain(observation?.observation?.kind);
		expect(observation?.observation?.content).toBeUndefined();

		child.stdin.write(
			`${JSON.stringify({
				type: "ack",
				bootId: ready.bootId,
				sequence: observation?.sequence,
			})}\n`,
		);
		child.stdin.write(
			`${JSON.stringify({
				type: "command",
				id: "shutdown-1",
				command: "shutdown",
			})}\n`,
		);
		child.stdin.flush();

		let shutdownResult: ObserverFrame | undefined;
		for (let index = 0; index < 4 && !shutdownResult; index += 1) {
			const frame = await frames.next();
			if (frame.type === "commandResult" && frame.id === "shutdown-1") {
				shutdownResult = frame;
			}
		}
		expect(shutdownResult?.ok).toBe(true);
		expect(await child.exited).toBe(0);
		runningChild = undefined;
	},
	20_000,
);
