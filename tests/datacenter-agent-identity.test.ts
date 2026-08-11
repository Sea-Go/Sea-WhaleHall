import { describe, expect, test } from "bun:test";
import {
	canonicalRequestPayload,
	fromBase64Std,
	generateNonce,
	isValidNonce,
	loadOrCreateAgentIdentity,
	readStoredIdentity,
	signAgentRequest,
	toBase64RawNoPadding,
	toBase64Std,
	type AgentSigningRequest,
} from "../src/bun/datacenter/agent-identity";
import { InMemorySecureValueStore } from "../src/bun/datacenter/secure-store";

function signingRequest(overrides: Partial<AgentSigningRequest> = {}): AgentSigningRequest {
	return {
		method: "POST",
		path: "/api/v1/agent/events/desktop/batch",
		timestamp: "2026-08-10T00:00:00Z",
		nonce: generateNonce(),
		bodyBytes: new TextEncoder().encode("{\"batchKey\":\"ec1_a:ec1_b\"}"),
		...overrides,
	};
}

describe("DataCenter Agent identity and Ed25519 signing", () => {
	test("creates a durable Ed25519 identity with a valid installation id", async () => {
		const store = new InMemorySecureValueStore();
		const identity = await loadOrCreateAgentIdentity(store);

		expect(identity.installationId).toMatch(/^[0-9a-f-]{36}$/u);
		expect(identity.publicKeyB64.length).toBeGreaterThan(0);
		expect(identity.privateKeyPkcs8B64.length).toBeGreaterThan(0);
		expect(identity.createdAtMs).toBeGreaterThan(0);
		expect(identity.publicKeyB64).not.toBe(identity.privateKeyPkcs8B64);

		// A reload must return the same identity (the private key round-trips).
		const reloaded = await loadOrCreateAgentIdentity(store);
		expect(reloaded).toEqual(identity);
		expect(readStoredIdentity(store)).toEqual(identity);
	});

	test("produces a signature verifiable with the exported public key", async () => {
		const store = new InMemorySecureValueStore();
		const identity = await loadOrCreateAgentIdentity(store);
		const request = signingRequest();
		const signature = await signAgentRequest(identity, request);

		const publicKey = await crypto.subtle.importKey(
			"raw",
			fromBase64Std(identity.publicKeyB64),
			{ name: "Ed25519" },
			false,
			["verify"],
		);
		const canonical = await canonicalRequestPayload(request);
		const valid = await crypto.subtle.verify(
			"Ed25519",
			publicKey,
			fromBase64Std(signature),
			canonical,
		);
		expect(valid).toBe(true);
	});

	test("canonical payload is deterministic for identical requests", async () => {
		const request = signingRequest();
		const first = await canonicalRequestPayload(request);
		const second = await canonicalRequestPayload({ ...request });
		expect(Buffer.from(first).toString("hex")).toBe(
			Buffer.from(second).toString("hex"),
		);
	});

	test("changing the nonce changes the canonical payload", async () => {
		const base = signingRequest();
		const first = await canonicalRequestPayload(base);
		const second = await canonicalRequestPayload({
			...base,
			nonce: generateNonce(),
		});
		expect(Buffer.from(first).toString("hex")).not.toBe(
			Buffer.from(second).toString("hex"),
		);
	});

	test("nonce generation satisfies the 16..128 safe character contract", () => {
		for (let index = 0; index < 20; index += 1) {
			const nonce = generateNonce();
			expect(isValidNonce(nonce)).toBe(true);
		}
		expect(isValidNonce("short")).toBe(false);
		expect(isValidNonce("x".repeat(200))).toBe(false);
		expect(isValidNonce("has space")).toBe(false);
	});

	test("base64 helpers round-trip and raw form is unpadded", () => {
		const bytes = new Uint8Array([0, 1, 2, 3, 255, 254]);
		expect(fromBase64Std(toBase64Std(bytes))).toEqual(bytes);
		const raw = toBase64RawNoPadding(bytes);
		expect(raw).not.toContain("=");
		expect(fromBase64Std(raw)).toEqual(bytes);
	});
});
