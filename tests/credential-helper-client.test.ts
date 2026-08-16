import { describe, expect, test } from "bun:test";
import {
	AUTH_REFRESH_TOKEN_CREDENTIAL,
	CredentialHelperClient,
	CredentialHelperError,
	type CredentialHelperRunner,
	LEGACY_AUTH_REFRESH_TOKEN_CREDENTIAL,
} from "../src/bun/credential-helper-client";

const encoder = new TextEncoder();

describe("CredentialHelperClient", () => {
	test("uses a fixed installation namespace and parses raw account keys", async () => {
		let request: Uint8Array | undefined;
		const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
		const client = createClient(async (input) => {
			request = input.slice();
			return response(`OK KEY ${key.byteLength}\n`, key);
		});

		await expect(
			client.getKey({
				installationId: "install-1",
				accountId: "account-key-hash",
				keyVersion: 1,
			}),
		).resolves.toEqual(key);
		const parsed = parseRequest(request ?? new Uint8Array());
		expect(parsed.header).toEqual({
			version: 1,
			kind: "account-key",
			operation: "get",
			installationId: "install-1",
			accountId: "account-key-hash",
			keyVersion: 1,
		});
		expect(parsed.body).toHaveLength(0);

		await expect(
			client.getKey({
				installationId: "other-installation",
				accountId: "account-key-hash",
				keyVersion: 1,
			}),
		).rejects.toEqual(expect.objectContaining({ code: "INVALID_REQUEST" }));
	});

	test("keeps refresh-token bytes out of the JSON header", async () => {
		const secret = "refresh-token-绝密-value";
		let observedHeader = "";
		let observedBody = new Uint8Array();
		const client = createClient(async (input) => {
			const parsed = parseRequest(input);
			observedHeader = new TextDecoder().decode(
				input.subarray(0, input.indexOf(10)),
			);
			observedBody = parsed.body.slice();
			return response("OK STORED\n");
		});

		await client.write(AUTH_REFRESH_TOKEN_CREDENTIAL, secret);
		expect(observedHeader).not.toContain(secret);
		expect(new TextDecoder().decode(observedBody)).toBe(secret);
		expect(JSON.parse(observedHeader)).toEqual({
			version: 1,
			kind: "named-secret",
			operation: "write",
			installationId: "install-1",
			name: AUTH_REFRESH_TOKEN_CREDENTIAL,
			secretBytes: encoder.encode(secret).byteLength,
		});
	});

	test("maps production NOT_FOUND reads to null and keeps legacy access delete-only", async () => {
		const operations: Array<Record<string, unknown>> = [];
		const client = createClient(async () =>
			response("ERR NOT_FOUND\n", undefined, 1),
		);
		await expect(
			client.read(AUTH_REFRESH_TOKEN_CREDENTIAL),
		).resolves.toBeNull();
		await expect(
			client.read(LEGACY_AUTH_REFRESH_TOKEN_CREDENTIAL),
		).rejects.toEqual(
			expect.objectContaining({ code: "SECRET_NAME_NOT_ALLOWED" }),
		);
		await expect(
			client.write(LEGACY_AUTH_REFRESH_TOKEN_CREDENTIAL, "retired-token"),
		).rejects.toEqual(
			expect.objectContaining({ code: "SECRET_NAME_NOT_ALLOWED" }),
		);
		await expect(client.read("auth.access-token.current")).rejects.toEqual(
			expect.objectContaining({ code: "SECRET_NAME_NOT_ALLOWED" }),
		);

		const deletionClient = createClient(async (input) => {
			operations.push(parseRequest(input).header);
			return response("OK DELETED 1\n");
		});
		await expect(
			deletionClient.delete(LEGACY_AUTH_REFRESH_TOKEN_CREDENTIAL),
		).resolves.toBeUndefined();
		expect(operations).toEqual([
			{
				version: 1,
				kind: "named-secret",
				operation: "delete",
				installationId: "install-1",
				name: LEGACY_AUTH_REFRESH_TOKEN_CREDENTIAL,
			},
		]);
	});

	test("fails closed on malformed payload sizes and any stderr", async () => {
		const malformed = createClient(async () =>
			response("OK KEY 32\n", new Uint8Array(31)),
		);
		await expect(
			malformed.getKey({
				installationId: "install-1",
				accountId: "account-1",
				keyVersion: 1,
			}),
		).rejects.toEqual(expect.objectContaining({ code: "PROTOCOL_ERROR" }));

		const noisy = createClient(async () => ({
			...response("OK DELETED 1\n"),
			stderr: encoder.encode("secret-looking diagnostic"),
		}));
		await expect(noisy.delete(AUTH_REFRESH_TOKEN_CREDENTIAL)).rejects.toEqual(
			expect.objectContaining({ code: "PROTOCOL_ERROR" }),
		);
	});
});

function createClient(runner: CredentialHelperRunner): CredentialHelperClient {
	return new CredentialHelperClient("unused-helper", {
		installationId: "install-1",
		runner,
	});
}

function response(
	header: string,
	payload: Uint8Array = new Uint8Array(),
	exitCode = 0,
) {
	const headerBytes = encoder.encode(header);
	const stdout = new Uint8Array(headerBytes.byteLength + payload.byteLength);
	stdout.set(headerBytes);
	stdout.set(payload, headerBytes.byteLength);
	return { stdout, stderr: new Uint8Array(), exitCode };
}

function parseRequest(input: Uint8Array): {
	header: Record<string, unknown>;
	body: Uint8Array;
} {
	const newline = input.indexOf(10);
	if (newline < 1) throw new CredentialHelperError("PROTOCOL_ERROR");
	return {
		header: JSON.parse(
			new TextDecoder().decode(input.subarray(0, newline)),
		) as Record<string, unknown>,
		body: input.slice(newline + 1),
	};
}
