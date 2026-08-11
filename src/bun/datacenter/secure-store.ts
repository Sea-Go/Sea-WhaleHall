import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * A tiny bounded key/value store for DataCenter secrets. Production uses the
 * macOS login Keychain through the `security` CLI; non-macOS development falls
 * back to owner-only files under the app data directory.
 */
export interface SecureValueStore {
	get(key: string): string | null;
	set(key: string, value: string): void;
	delete(key: string): void;
}

const KEYCHAIN_SERVICE = "whalehall-datacenter";
const MAXIMUM_VALUE_BYTES = 32 * 1024;
const MAXIMUM_KEY_LENGTH = 128;

export class KeychainSecureValueStore implements SecureValueStore {
	constructor(private readonly service: string = KEYCHAIN_SERVICE) {}

	get(key: string): string | null {
		assertKey(key);
		try {
			const value = execFileSync(
				"security",
				[
					"find-generic-password",
					"-s",
					this.service,
					"-a",
					key,
					"-w",
				],
				{
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				},
			).trim();
			return value.length === 0 ? null : value;
		} catch {
			return null;
		}
	}

	set(key: string, value: string): void {
		assertKey(key);
		if (Buffer.byteLength(value, "utf8") > MAXIMUM_VALUE_BYTES) {
			throw new Error("DataCenter secure value is too large.");
		}
		execFileSync(
			"security",
			[
				"add-generic-password",
				"-s",
				this.service,
				"-a",
				key,
				"-w",
				value,
				"-U",
			],
			{ stdio: "ignore" },
		);
	}

	delete(key: string): void {
		assertKey(key);
		try {
			execFileSync(
				"security",
				["delete-generic-password", "-s", this.service, "-a", key],
				{ stdio: "ignore" },
			);
		} catch {
			// Absent entries are already the desired state.
		}
	}
}

export class FileSecureValueStore implements SecureValueStore {
	constructor(private readonly directory: string) {}

	get(key: string): string | null {
		assertKey(key);
		const path = this.path(key);
		if (!existsSync(path)) return null;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as {
				value?: unknown;
			};
			return typeof parsed.value === "string" ? parsed.value : null;
		} catch {
			return null;
		}
	}

	set(key: string, value: string): void {
		assertKey(key);
		if (Buffer.byteLength(value, "utf8") > MAXIMUM_VALUE_BYTES) {
			throw new Error("DataCenter secure value is too large.");
		}
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		writeFileSync(
			this.path(key),
			JSON.stringify({ value }),
			{ mode: 0o600 },
		);
	}

	delete(key: string): void {
		assertKey(key);
		try {
			rmSync(this.path(key), { force: true });
		} catch {
			// Absent entries are already the desired state.
		}
	}

	private path(key: string): string {
		const safe = key.replace(/[^A-Za-z0-9._-]/gu, "_");
		return join(this.directory, safe + ".json");
	}
}

export class InMemorySecureValueStore implements SecureValueStore {
	private readonly values = new Map<string, string>();

	get(key: string): string | null {
		return this.values.get(key) ?? null;
	}

	set(key: string, value: string): void {
		assertKey(key);
		if (Buffer.byteLength(value, "utf8") > MAXIMUM_VALUE_BYTES) {
			throw new Error("DataCenter secure value is too large.");
		}
		this.values.set(key, value);
	}

	delete(key: string): void {
		this.values.delete(key);
	}
}

export function createSecureValueStore(options: {
	directory: string;
	platform?: NodeJS.Platform;
}): SecureValueStore {
	const platform = options.platform ?? process.platform;
	return platform === "darwin"
		? new KeychainSecureValueStore()
		: new FileSecureValueStore(options.directory);
}

function assertKey(key: string): void {
	if (
		key.length === 0 ||
		key.length > MAXIMUM_KEY_LENGTH ||
		/[\u0000-\u001f\u007f]/u.test(key)
	) {
		throw new Error("DataCenter secure key is invalid.");
	}
}
