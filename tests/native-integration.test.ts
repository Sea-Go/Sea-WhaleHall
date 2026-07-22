import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LocalMessage } from "../src/agent/local-protocol";

test("whalehall-local lists, calls, streams, and cancels tools over JSONL", async () => {
	const projectRoot = resolve(import.meta.dir, "..");
	const manifest = resolve(projectRoot, "whalehall-local/Cargo.toml");
	const build = Bun.spawnSync(
		[
			"cargo",
			"build",
			"--locked",
			"--manifest-path",
			manifest,
			"--package",
			"whalehall-local-server",
		],
		{ cwd: projectRoot, stdout: "pipe", stderr: "pipe" },
	);
	if (build.exitCode !== 0) throw new Error(new TextDecoder().decode(build.stderr));

	const binary = resolve(
		projectRoot,
		"whalehall-local/target/debug",
		process.platform === "win32" ? "whalehall-local.exe" : "whalehall-local",
	);
	const dataDirectory = mkdtempSync(join(tmpdir(), "whalehall-activity-integration-"));
	const child = Bun.spawn({
		cmd: [binary],
		env: {
			...process.env,
			WHALEHALL_DATA_DIR: dataDirectory,
			WHALEHALL_ACTIVITY_POLL_MS: "50",
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const messages: LocalMessage[] = [];
	const waitStarted = deferred();
	const waitProgress = deferred();
	const outputComplete = collectMessages(child.stdout, messages, (message) => {
		if ("event" in message && message.callId === "wait" && message.event === "tool.started") {
			waitStarted.resolve();
		}
		if ("event" in message && message.callId === "wait" && message.event === "tool.progress") {
			waitProgress.resolve();
		}
	});
	child.stdin.write('{"id":"list","method":"tool.list","params":{}}\n');
	child.stdin.write(
		'{"id":"system","method":"tool.call","params":{"name":"system.info","arguments":{}}}\n',
	);
	child.stdin.write(
		'{"id":"activity-status","method":"tool.call","params":{"name":"activity.status","arguments":{}}}\n',
	);
	child.stdin.write(
		'{"id":"activity-sessions","method":"tool.call","params":{"name":"activity.sessions","arguments":{"limit":10}}}\n',
	);
	child.stdin.write(
		'{"id":"activity-cleanup","method":"tool.call","params":{"name":"activity.cleanup","arguments":{"scope":"shortTerm"}}}\n',
	);
	child.stdin.write(
		'{"id":"wait","method":"tool.call","params":{"name":"demo.wait","arguments":{"durationMs":2000}}}\n',
	);
	await child.stdin.flush();
	await withTimeout(waitStarted.promise, "tool.started");
	await withTimeout(waitProgress.promise, "tool.progress");
	child.stdin.write(
		'{"id":"cancel","method":"tool.cancel","params":{"callId":"wait"}}\n',
	);
	child.stdin.end();

	await outputComplete;
	const exitCode = await child.exited;
	expect(exitCode).toBe(0);

	const listResponse = messages.find(
		(message) => "id" in message && message.id === "list" && message.ok,
	) as { result: { tools: Array<{ name: string }> } } | undefined;
	expect(listResponse?.result.tools.map((tool) => tool.name)).toEqual([
		"activity.cleanup",
		"activity.sessions",
		"activity.status",
		"demo.wait",
		"system.info",
	]);
	expect(messages.find((message) => "id" in message && message.id === "system")).toMatchObject({
		ok: true,
		result: { callId: "system", output: { pid: expect.any(Number) } },
	});
	expect(
		messages.find((message) => "id" in message && message.id === "activity-status"),
	).toMatchObject({
		ok: true,
		result: {
			callId: "activity-status",
			output: {
				databasePath: join(dataDirectory, "usage.sqlite3"),
				pollIntervalMs: 50,
			},
		},
	});
	expect(
		messages.find((message) => "id" in message && message.id === "activity-sessions"),
	).toMatchObject({
		ok: true,
		result: {
			callId: "activity-sessions",
			output: { count: expect.any(Number), sessions: expect.any(Array) },
		},
	});
	expect(
		messages.find((message) => "id" in message && message.id === "activity-cleanup"),
	).toMatchObject({
		ok: true,
		result: {
			callId: "activity-cleanup",
			output: {
				scope: "shortTerm",
				deletedSessions: expect.any(Number),
				retentionDays: 7,
				cutoffAtMs: expect.any(Number),
			},
		},
	});
	expect(messages.some((message) => "event" in message && message.event === "tool.started")).toBe(
		true,
	);
	expect(messages.some((message) => "event" in message && message.event === "tool.progress")).toBe(
		true,
	);
	expect(
		messages.some((message) => "event" in message && message.event === "tool.cancelled"),
	).toBe(true);
	expect(messages.find((message) => "id" in message && message.id === "cancel")).toMatchObject({
		ok: true,
		result: { callId: "wait", cancelled: true },
	});
	expect(messages.find((message) => "id" in message && message.id === "wait")).toMatchObject({
		ok: false,
		error: { code: "CANCELLED" },
	});
	expect(existsSync(join(dataDirectory, "usage.sqlite3"))).toBe(true);
	rmSync(dataDirectory, { recursive: true, force: true });
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

async function withTimeout(promise: Promise<void>, label: string): Promise<void> {
	await Promise.race([
		promise,
		Bun.sleep(3000).then(() => {
			throw new Error(`Timed out waiting for ${label}`);
		}),
	]);
}

async function collectMessages(
	stream: ReadableStream<Uint8Array>,
	messages: LocalMessage[],
	onMessage: (message: LocalMessage) => void,
): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).trimEnd();
				buffer = buffer.slice(newline + 1);
				if (line) {
					const message = JSON.parse(line) as LocalMessage;
					messages.push(message);
					onMessage(message);
				}
				newline = buffer.indexOf("\n");
			}
		}
	} finally {
		reader.releaseLock();
	}
}
