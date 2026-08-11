import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateAgentIdentity } from "../src/bun/datacenter/agent-identity";
import { DataCenterHttpClient } from "../src/bun/datacenter/http";
import { InMemorySecureValueStore } from "../src/bun/datacenter/secure-store";
import {
	DATACENTER_SYNC_CONSUMER_ID,
	DataCenterSyncLoop,
	cursorForSequence,
	type DataCenterSyncContext,
	type UploadCandidateEvent,
} from "../src/bun/datacenter/sync-loop";
import { parseDesktopCursor } from "../src/bun/datacenter/payload-projection";
import type { DataCenterAgentRegistration } from "../src/bun/datacenter/types";

type FetchCall = { url: string; init: RequestInit };

function eventAt(
	sequence: number,
	overrides: Partial<UploadCandidateEvent> = {},
): UploadCandidateEvent {
	const now = Date.now();
	return {
		schemaVersion: "desktop-event.v1",
		eventId: `de1_${"0".repeat(58)}${sequence.toString(16).padStart(6, "0")}`,
		cursor: cursorForSequence(sequence),
		deviceId: "local-device",
		sessionId: "local-session",
		kind: "presence.afkStarted",
		source: "presence",
		occurredAtMs: now - 10_000,
		observedAtMs: now - 10_000,
		goalVersion: null,
		sensitivity: "metadata",
		payload: { idleForMs: 5_000 },
		...overrides,
	};
}

function metadataEventAt(
	sequence: number,
	payload: Record<string, unknown>,
): UploadCandidateEvent {
	return eventAt(sequence, { kind: "editor.documentChanged", payload });
}

function contentEventAt(sequence: number): UploadCandidateEvent {
	return eventAt(sequence, {
		kind: "goal.contextChanged",
		sensitivity: "content",
		payload: { previous: null, next: null },
	});
}

async function makeLoop(options: {
	events: UploadCandidateEvent[];
	fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
	accessToken?: string | null;
	agentId?: string | null;
	registration?: DataCenterAgentRegistration | null;
	now?: () => number;
}) {
	const store = new InMemorySecureValueStore();
	const identity = await loadOrCreateAgentIdentity(store);
	const http = new DataCenterHttpClient({
		baseUrl: "http://dc.test",
		fetch: options.fetchImpl,
		timeoutMs: 5_000,
	});
	const session = { accessToken: options.accessToken ?? null };
	const agent = { agentId: options.agentId ?? null };
	const committed: string[] = [];
	const committedSequence = { value: 0 };
	const context: DataCenterSyncContext = {
		baseUrl: "http://dc.test",
		http,
		identity,
		eventSource: {
			async queryEvents(consumerId, limit) {
				expect(consumerId).toBe(DATACENTER_SYNC_CONSUMER_ID);
				expect(limit).toBeGreaterThanOrEqual(1);
				return {
					events: options.events.filter((event) => {
						const sequence = parseDesktopCursor(event.cursor) ?? 0;
						return sequence > committedSequence.value;
					}),
					hasMore: false,
				};
			},
			async commitCursor(consumerId, cursor) {
				expect(consumerId).toBe(DATACENTER_SYNC_CONSUMER_ID);
				committed.push(cursor);
				const sequence = parseDesktopCursor(cursor) ?? 0;
				if (sequence > committedSequence.value) {
					committedSequence.value = sequence;
				}
				return { advanced: true };
			},
		},
		readAccessToken: async () => session.accessToken,
		readAgentId: async () => agent.agentId,
		registerAgent: async () => {
			const registration = options.registration;
			if (registration === null || registration === undefined) return null;
			agent.agentId = registration.agentId;
			return registration;
		},
		now: options.now ?? Date.now,
	};
	const directory = mkdtempSync(join(tmpdir(), "whalehall-dc-sync-"));
	const loop = new DataCenterSyncLoop({
		context,
		stateFile: join(directory, "sync-state.v1.json"),
		intervalMs: 1_000,
		now: options.now ?? Date.now,
	});
	return {
		loop,
		directory,
		session,
		agent,
		getCommitted: () => committed,
	};
}

function fetchOk(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function fetchError(status: number, message: string): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function ackBody(lastCursor: string) {
	return {
		batchId: "11111111-1111-1111-1111-111111111111",
		ackCursor: lastCursor,
		acceptedCount: 1,
		duplicateCount: 0,
		results: [
			{
				eventId: "de1_000000000000000000000000000000000000000000000000000000000001",
				cursor: lastCursor,
				status: "accepted" as const,
			},
		],
	};
}

describe("DataCenter sync loop", () => {
	test("stays disabled when sync is not enabled", async () => {
		const { loop, directory } = await makeLoop({
			events: [eventAt(1)],
			fetchImpl: async () => {
				throw new Error("must not upload while disabled");
			},
			accessToken: "token",
			agentId: "agent",
		});
		try {
			await loop.tick();
			const status = await loop.getStatus();
			expect(status.state).toBe("disabled");
			expect(status.enabled).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("requires a session before uploading", async () => {
		const { loop, directory } = await makeLoop({
			events: [eventAt(1)],
			fetchImpl: async () => {
				throw new Error("must not upload without a session");
			},
			accessToken: null,
			agentId: "agent",
		});
		try {
			await loop.setEnabled(true);
			const status = await loop.getStatus();
			expect(status.state).toBe("needs_session");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("registers the Agent before uploading", async () => {
		let uploaded = false;
		const { loop, directory, agent } = await makeLoop({
			events: [eventAt(1)],
			fetchImpl: async () => {
				uploaded = true;
				return fetchOk(ackBody(cursorForSequence(1)));
			},
			accessToken: "token",
			agentId: null,
			registration: {
				agentId: "agent-1",
				deviceId: "device-1",
				configVersion: 1,
			},
		});
		try {
			await loop.setEnabled(true);
			const status = await loop.getStatus();
			expect(status.state).toBe("ready");
			expect(agent.agentId).toBe("agent-1");
			expect(uploaded).toBe(true);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("commits the ackCursor after a successful batch", async () => {
		const calls: FetchCall[] = [];
		const { loop, directory, getCommitted } = await makeLoop({
			events: [eventAt(1), eventAt(2)],
			fetchImpl: async (url, init) => {
				calls.push({ url, init });
				return fetchOk(ackBody(cursorForSequence(2)));
			},
			accessToken: "token",
			agentId: "agent-1",
		});
		try {
			await loop.setEnabled(true);
			const status = await loop.getStatus();
			expect(status.state).toBe("ready");
			expect(getCommitted()).toEqual([cursorForSequence(2)]);
			expect(calls.length).toBe(1);
			const body = JSON.parse(String(calls[0]?.init.body ?? "{}")) as {
				batchKey?: string;
				firstCursor?: string;
				lastCursor?: string;
			};
			expect(body.batchKey).toBe(`${cursorForSequence(1)}:${cursorForSequence(2)}`);
			expect(body.firstCursor).toBe(cursorForSequence(1));
			expect(body.lastCursor).toBe(cursorForSequence(2));
			const headers = calls[0]?.init.headers as Record<string, string>;
			expect(headers["X-Agent-ID"]).toBe("agent-1");
			expect(headers["X-Agent-Nonce"]).toBeTruthy();
			expect(headers["X-Agent-Signature"]).toBeTruthy();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("blocks locally on a content event and never uploads it", async () => {
		let uploaded = false;
		const { loop, directory, getCommitted } = await makeLoop({
			events: [eventAt(1), contentEventAt(2), eventAt(3)],
			fetchImpl: async () => {
				uploaded = true;
				return fetchOk(ackBody(cursorForSequence(1)));
			},
			accessToken: "token",
			agentId: "agent-1",
		});
		try {
			await loop.setEnabled(true);
			const status = await loop.getStatus();
			expect(status.state).toBe("blocked_content");
			expect(status.blockedCursor).toBe(cursorForSequence(2));
			expect(uploaded).toBe(false);
			expect(getCommitted()).toEqual([]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("blocks on metadata that cannot be projected", async () => {
		const { loop, directory } = await makeLoop({
			events: [metadataEventAt(1, { editorId: "vscode" })],
			fetchImpl: async () => {
				throw new Error("must not upload unprojectable metadata");
			},
			accessToken: "token",
			agentId: "agent-1",
		});
		try {
			await loop.setEnabled(true);
			const status = await loop.getStatus();
			expect(status.state).toBe("blocked_reconcile");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("enters retry_wait on a network failure and reuses the same batch with a fresh nonce", async () => {
		let attempt = 0;
		const nonces: string[] = [];
		let clock = 0;
		const { loop, directory, getCommitted } = await makeLoop({
			events: [eventAt(1)],
			fetchImpl: async (_url, init) => {
				const headers = init.headers as Record<string, string>;
				nonces.push(headers["X-Agent-Nonce"] ?? "");
				attempt += 1;
				if (attempt === 1) throw new TypeError("fetch failed");
				return fetchOk(ackBody(cursorForSequence(1)));
			},
			accessToken: "token",
			agentId: "agent-1",
			now: () => clock,
		});
		try {
			clock = 100;
			await loop.setEnabled(true);
			let status = await loop.getStatus();
			expect(status.state).toBe("retry_wait");
			expect(status.lastErrorCode).toBe("offline");
			expect(getCommitted()).toEqual([]);

			// Advance past the backoff window and retry.
			clock = 100 + 5_000;
			await loop.tick();
			status = await loop.getStatus();
			expect(status.state).toBe("ready");
			expect(getCommitted()).toEqual([cursorForSequence(1)]);
			expect(nonces.length).toBe(2);
			expect(nonces[0]).not.toBe(nonces[1]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("maps Agent 401 to needs_agent", async () => {
		const { loop, directory } = await makeLoop({
			events: [eventAt(1)],
			fetchImpl: async () => fetchError(401, "invalid request signature"),
			accessToken: "token",
			agentId: "agent-1",
		});
		try {
			await loop.setEnabled(true);
			const status = await loop.getStatus();
			expect(status.state).toBe("needs_agent");
			expect(status.lastErrorCode).toBe("agent_invalid");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("maps consent 403 to blocked_reconcile", async () => {
		const { loop, directory } = await makeLoop({
			events: [eventAt(1)],
			fetchImpl: async () => fetchError(403, "consent revoked"),
			accessToken: "token",
			agentId: "agent-1",
		});
		try {
			await loop.setEnabled(true);
			const status = await loop.getStatus();
			expect(status.state).toBe("blocked_reconcile");
			expect(status.lastErrorCode).toBe("consent_revoked");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("maps a 400 time-window violation to blocked_reconcile", async () => {
		const { loop, directory } = await makeLoop({
			events: [eventAt(1)],
			fetchImpl: async () =>
				fetchError(400, "desktop event timestamp is outside accepted range"),
			accessToken: "token",
			agentId: "agent-1",
		});
		try {
			await loop.setEnabled(true);
			const status = await loop.getStatus();
			expect(status.state).toBe("blocked_reconcile");
			expect(status.lastErrorCode).toBe("time_window_violation");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("maps 503 to blocked_reconcile without committing", async () => {
		const { loop, directory, getCommitted } = await makeLoop({
			events: [eventAt(1)],
			fetchImpl: async () =>
				fetchError(503, "encrypted content ingestion is unavailable"),
			accessToken: "token",
			agentId: "agent-1",
		});
		try {
			await loop.setEnabled(true);
			const status = await loop.getStatus();
			expect(status.state).toBe("blocked_reconcile");
			expect(status.lastErrorCode).toBe("server_unavailable");
			expect(getCommitted()).toEqual([]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("treats an ackCursor behind the batch as a contract violation", async () => {
		const { loop, directory, getCommitted } = await makeLoop({
			events: [eventAt(1)],
			fetchImpl: async () =>
				fetchOk({
					...ackBody(cursorForSequence(1)),
					ackCursor: cursorForSequence(0),
				}),
			accessToken: "token",
			agentId: "agent-1",
		});
		try {
			await loop.setEnabled(true);
			const status = await loop.getStatus();
			expect(status.state).toBe("blocked_reconcile");
			expect(status.lastErrorCode).toBe("contract_violation");
			expect(getCommitted()).toEqual([]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
