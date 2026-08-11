import { afterEach, describe, expect, test } from "bun:test";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FileSecureValueStore,
	InMemorySecureValueStore,
} from "../src/bun/datacenter/secure-store";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "whalehall-secure-"));
	directories.push(directory);
	return directory;
}

describe("DataCenter secure value stores", () => {
	test("in-memory store round-trips and deletes", () => {
		const store = new InMemorySecureValueStore();
		expect(store.get("missing")).toBeNull();
		store.set("session", "secret-value");
		expect(store.get("session")).toBe("secret-value");
		store.set("session", "updated");
		expect(store.get("session")).toBe("updated");
		store.delete("session");
		expect(store.get("session")).toBeNull();
	});

	test("file store persists values with owner-only permissions", () => {
		const directory = temporaryDirectory();
		const store = new FileSecureValueStore(join(directory, "keys"));
		store.set("agent-identity.v1", "{}");
		expect(store.get("agent-identity.v1")).toBe("{}");
		store.delete("agent-identity.v1");
		expect(store.get("agent-identity.v1")).toBeNull();
	});

	test("file store writes mode 0600", () => {
		const directory = temporaryDirectory();
		const store = new FileSecureValueStore(join(directory, "keys"));
		store.set("token", "abc");
		const path = join(directory, "keys", "token.json");
		expect(lstatSync(path).mode & 0o777).toBe(0o600);
	});

	test("file store treats corrupt entries as missing", () => {
		const directory = temporaryDirectory();
		const keysDirectory = join(directory, "keys");
		mkdirSync(keysDirectory, { recursive: true });
		const store = new FileSecureValueStore(keysDirectory);
		writeFileSync(join(keysDirectory, "broken.json"), "not-json", {
			mode: 0o600,
		});
		expect(store.get("broken")).toBeNull();
	});

	test("rejects invalid keys and oversized values", () => {
		const store = new InMemorySecureValueStore();
		expect(() => store.set("bad\u0000key", "x")).toThrow();
		expect(() => store.set("", "x")).toThrow();
		expect(() => store.set("ok", "x".repeat(40_000))).toThrow();
	});
});
