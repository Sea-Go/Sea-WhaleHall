const PROTOCOL_VERSION = 1;
const ACCOUNT_KEY_BYTES = 32;
const MAX_SECRET_BYTES = 2_048;
const MAX_STDOUT_BYTES = MAX_SECRET_BYTES + 128;
const MAX_STDERR_BYTES = 1_024;
const DEFAULT_TIMEOUT_MS = 5_000;

/** Production-only name; retired builds do not know or overwrite this slot. */
export const AUTH_REFRESH_TOKEN_CREDENTIAL = "auth.refresh-token.production.v1";
/** Compatibility-only deletion target used by the production-origin cutover. */
export const LEGACY_AUTH_REFRESH_TOKEN_CREDENTIAL =
	"auth.refresh-token.current";
const CURRENT_SECRET_NAMES = new Set([AUTH_REFRESH_TOKEN_CREDENTIAL]);

export type CredentialKeyReference = {
	installationId: string;
	accountId: string;
	keyVersion: number;
};

export interface CredentialKeyStore {
	getKey(reference: CredentialKeyReference): Promise<Uint8Array>;
	createKey(reference: CredentialKeyReference): Promise<Uint8Array>;
	deleteKey(reference: CredentialKeyReference): Promise<{ deleted: boolean }>;
}

export interface SecureCredentialStore {
	read(name: string): Promise<string | null>;
	write(name: string, value: string): Promise<void>;
	delete(name: string): Promise<void>;
}

export type CredentialHelperRunResult = {
	stdout: Uint8Array;
	stderr: Uint8Array;
	exitCode: number;
};

export type CredentialHelperRunner = (
	input: Uint8Array,
) => Promise<CredentialHelperRunResult>;

export interface CredentialHelperClientOptions {
	installationId: string;
	timeoutMs?: number;
	runner?: CredentialHelperRunner;
	environment?: Readonly<Record<string, string>>;
}

export class CredentialHelperError extends Error {
	constructor(
		public readonly code: string,
		message = safeMessage(code),
	) {
		super(message);
		this.name = "CredentialHelperError";
	}
}

/**
 * Private Bun-side transport for the one-shot OS credential helper.
 *
 * Requests and secret bodies use stdin; responses use stdout. Secrets never
 * enter argv, the environment, stderr, or the renderer RPC surface.
 */
export class CredentialHelperClient
	implements CredentialKeyStore, SecureCredentialStore
{
	private readonly runner: CredentialHelperRunner;
	private readonly installationId: string;

	constructor(binaryPath: string, options: CredentialHelperClientOptions) {
		validateComponent(options.installationId, "installationId");
		if (
			options.timeoutMs !== undefined &&
			(!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
		) {
			throw new CredentialHelperError(
				"INVALID_REQUEST",
				"Credential helper timeout must be a positive integer.",
			);
		}
		this.installationId = options.installationId;
		this.runner =
			options.runner ??
			createProcessRunner(
				binaryPath,
				options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				options.environment,
			);
	}

	async getKey(reference: CredentialKeyReference): Promise<Uint8Array> {
		const response = await this.request(
			accountKeyRequest("get", reference, this.installationId),
		);
		return requirePayload(response, "KEY", ACCOUNT_KEY_BYTES);
	}

	async createKey(reference: CredentialKeyReference): Promise<Uint8Array> {
		const response = await this.request(
			accountKeyRequest("create", reference, this.installationId),
		);
		return requirePayload(response, "KEY", ACCOUNT_KEY_BYTES);
	}

	async deleteKey(
		reference: CredentialKeyReference,
	): Promise<{ deleted: boolean }> {
		const response = await this.request(
			accountKeyRequest("delete", reference, this.installationId),
		);
		return { deleted: requireDeleted(response) };
	}

	async read(name: string): Promise<string | null> {
		return this.readSecret(name);
	}

	async write(name: string, value: string): Promise<void> {
		await this.writeSecret(name, value);
	}

	async delete(name: string): Promise<void> {
		await this.deleteSecret(name);
	}

	async readSecret(name: string): Promise<string | null> {
		validateSecretOperation(name, "read");
		try {
			const response = await this.request({
				version: PROTOCOL_VERSION,
				kind: "named-secret",
				operation: "read",
				installationId: this.installationId,
				name,
			});
			const bytes = requirePayload(response, "SECRET");
			try {
				return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			} catch {
				throw new CredentialHelperError("CORRUPT_SECRET");
			} finally {
				bytes.fill(0);
			}
		} catch (error) {
			if (
				error instanceof CredentialHelperError &&
				error.code === "NOT_FOUND"
			) {
				return null;
			}
			throw error;
		}
	}

	async writeSecret(name: string, value: string): Promise<void> {
		validateSecretOperation(name, "write");
		const secret = new TextEncoder().encode(value);
		try {
			if (secret.byteLength < 1 || secret.byteLength > MAX_SECRET_BYTES) {
				throw new CredentialHelperError(
					"INVALID_REQUEST",
					`Credential secret must contain between 1 and ${MAX_SECRET_BYTES} UTF-8 bytes.`,
				);
			}
			const response = await this.request(
				{
					version: PROTOCOL_VERSION,
					kind: "named-secret",
					operation: "write",
					installationId: this.installationId,
					name,
					secretBytes: secret.byteLength,
				},
				secret,
			);
			if (
				response.header !== "OK STORED" ||
				response.payload.byteLength !== 0
			) {
				throw new CredentialHelperError("PROTOCOL_ERROR");
			}
		} finally {
			secret.fill(0);
		}
	}

	async deleteSecret(name: string): Promise<{ deleted: boolean }> {
		validateSecretOperation(name, "delete");
		const response = await this.request({
			version: PROTOCOL_VERSION,
			kind: "named-secret",
			operation: "delete",
			installationId: this.installationId,
			name,
		});
		return { deleted: requireDeleted(response) };
	}

	private async request(
		header: Readonly<Record<string, unknown>>,
		secret?: Uint8Array,
	): Promise<HelperResponse> {
		const headerBytes = new TextEncoder().encode(`${JSON.stringify(header)}\n`);
		const input = new Uint8Array(
			headerBytes.byteLength + (secret?.byteLength ?? 0),
		);
		input.set(headerBytes);
		if (secret) input.set(secret, headerBytes.byteLength);
		let result: CredentialHelperRunResult;
		try {
			result = await this.runner(input);
		} catch (error) {
			if (error instanceof CredentialHelperError) throw error;
			throw new CredentialHelperError("SPAWN_FAILED");
		} finally {
			input.fill(0);
			headerBytes.fill(0);
		}
		if (result.stderr.byteLength > 0) {
			result.stderr.fill(0);
			result.stdout.fill(0);
			throw new CredentialHelperError("PROTOCOL_ERROR");
		}
		let response: HelperResponse;
		try {
			response = parseResponse(result.stdout);
		} finally {
			result.stdout.fill(0);
		}
		if (response.errorCode) {
			response.payload.fill(0);
			throw new CredentialHelperError(response.errorCode);
		}
		if (result.exitCode !== 0) {
			response.payload.fill(0);
			throw new CredentialHelperError("PROCESS_EXITED");
		}
		return response;
	}
}

type HelperResponse = {
	header: string;
	payload: Uint8Array;
	errorCode?: string;
};

function accountKeyRequest(
	operation: "get" | "create" | "delete",
	reference: CredentialKeyReference,
	expectedInstallationId: string,
): Record<string, unknown> {
	validateComponent(reference.installationId, "installationId");
	if (reference.installationId !== expectedInstallationId) {
		throw new CredentialHelperError(
			"INVALID_REQUEST",
			"Credential key reference belongs to a different installation.",
		);
	}
	validateComponent(reference.accountId, "accountId");
	if (
		!Number.isSafeInteger(reference.keyVersion) ||
		reference.keyVersion < 1 ||
		reference.keyVersion > 1_000_000
	) {
		throw new CredentialHelperError("INVALID_REQUEST");
	}
	return {
		version: PROTOCOL_VERSION,
		kind: "account-key",
		operation,
		installationId: reference.installationId,
		accountId: reference.accountId,
		keyVersion: reference.keyVersion,
	};
}

function parseResponse(stdout: Uint8Array): HelperResponse {
	const newline = stdout.indexOf(10);
	if (newline < 1 || newline > 127) {
		throw new CredentialHelperError("PROTOCOL_ERROR");
	}
	let header: string;
	try {
		header = new TextDecoder("utf-8", { fatal: true }).decode(
			stdout.subarray(0, newline),
		);
	} catch {
		throw new CredentialHelperError("PROTOCOL_ERROR");
	}
	const payload = stdout.slice(newline + 1);
	if (header.startsWith("ERR ")) {
		const code = header.slice(4);
		if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(code) || payload.byteLength !== 0) {
			payload.fill(0);
			throw new CredentialHelperError("PROTOCOL_ERROR");
		}
		return { header, payload, errorCode: code };
	}
	return { header, payload };
}

function requirePayload(
	response: HelperResponse,
	kind: "KEY" | "SECRET",
	exactLength?: number,
): Uint8Array {
	const match = new RegExp(`^OK ${kind} ([0-9]+)$`).exec(response.header);
	const declared = match ? Number(match[1]) : Number.NaN;
	if (
		!Number.isSafeInteger(declared) ||
		declared !== response.payload.byteLength ||
		(exactLength !== undefined && declared !== exactLength) ||
		(kind === "SECRET" && (declared < 1 || declared > MAX_SECRET_BYTES))
	) {
		response.payload.fill(0);
		throw new CredentialHelperError("PROTOCOL_ERROR");
	}
	return response.payload;
}

function requireDeleted(response: HelperResponse): boolean {
	if (response.payload.byteLength !== 0) {
		response.payload.fill(0);
		throw new CredentialHelperError("PROTOCOL_ERROR");
	}
	if (response.header === "OK DELETED 1") return true;
	if (response.header === "OK DELETED 0") return false;
	throw new CredentialHelperError("PROTOCOL_ERROR");
}

function validateSecretOperation(
	name: string,
	operation: "read" | "write" | "delete",
): void {
	if (
		!CURRENT_SECRET_NAMES.has(name) &&
		!(operation === "delete" && name === LEGACY_AUTH_REFRESH_TOKEN_CREDENTIAL)
	) {
		throw new CredentialHelperError("SECRET_NAME_NOT_ALLOWED");
	}
}

function validateComponent(value: string, field: string): void {
	if (
		value.length < 1 ||
		value.length > 128 ||
		!/^[a-z0-9][a-z0-9._-]*$/.test(value)
	) {
		throw new CredentialHelperError(
			"INVALID_REQUEST",
			`Credential helper ${field} is invalid.`,
		);
	}
}

function createProcessRunner(
	binaryPath: string,
	timeoutMs: number,
	environment?: Readonly<Record<string, string>>,
): CredentialHelperRunner {
	return async (input) => {
		let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
		try {
			child = Bun.spawn({
				cmd: [binaryPath],
				env: environment ? { ...environment } : minimalEnvironment(),
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
		} catch {
			throw new CredentialHelperError("SPAWN_FAILED");
		}
		child.stdin.write(input);
		void child.stdin.end();
		const timeout = new Promise<never>((_, reject) => {
			const timer = globalThis.setTimeout(() => {
				try {
					child.kill();
				} catch {}
				reject(new CredentialHelperError("REQUEST_TIMEOUT"));
			}, timeoutMs);
			void child.exited.finally(() => globalThis.clearTimeout(timer));
		});
		return Promise.race([
			Promise.all([
				readBounded(child.stdout, MAX_STDOUT_BYTES),
				readBounded(child.stderr, MAX_STDERR_BYTES),
				child.exited,
			]).then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode })),
			timeout,
		]);
	};
}

async function readBounded(
	stream: ReadableStream<Uint8Array>,
	maximumBytes: number,
): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			length += next.value.byteLength;
			if (length > maximumBytes) {
				throw new CredentialHelperError("PROTOCOL_ERROR");
			}
			chunks.push(next.value);
		}
		const output = new Uint8Array(length);
		let offset = 0;
		for (const chunk of chunks) {
			output.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return output;
	} finally {
		for (const chunk of chunks) chunk.fill(0);
		reader.releaseLock();
	}
}

function minimalEnvironment(): Record<string, string> {
	const names =
		process.platform === "win32"
			? [
					"SystemRoot",
					"WINDIR",
					"TEMP",
					"TMP",
					"USERPROFILE",
					"LOCALAPPDATA",
					"APPDATA",
				]
			: ["HOME", "TMPDIR", "USER", "LOGNAME"];
	const environment: Record<string, string> = {};
	for (const name of names) {
		const value = process.env[name];
		if (value) environment[name] = value;
	}
	return environment;
}

function safeMessage(code: string): string {
	switch (code) {
		case "NOT_FOUND":
			return "The requested secure credential does not exist.";
		case "STORE_UNAVAILABLE":
			return "The operating-system credential store is unavailable.";
		case "UNSUPPORTED_PLATFORM":
			return "Persistent credentials are unsupported on this platform.";
		case "REQUEST_TIMEOUT":
			return "The credential helper did not respond in time.";
		default:
			return "The secure credential operation failed.";
	}
}
