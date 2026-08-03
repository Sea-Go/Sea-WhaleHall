import {
	randomBytes,
	scrypt as nodeScrypt,
	timingSafeEqual,
} from "node:crypto";

const FORMAT = "scrypt";
const VERSION = "v=1";
const DEFAULT_N = 16_384;
const DEFAULT_R = 8;
const DEFAULT_P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

export interface ScryptPasswordOptions {
	N?: number;
	r?: number;
	p?: number;
	salt?: Uint8Array;
}

/**
 * Creates the password format consumed by the relay's user store. This helper
 * is intended for account provisioning; plaintext passwords are never stored.
 */
export async function createScryptPasswordHash(
	password: string,
	options: ScryptPasswordOptions = {},
): Promise<string> {
	assertPassword(password);
	const params = validateParams({
		N: options.N ?? DEFAULT_N,
		r: options.r ?? DEFAULT_R,
		p: options.p ?? DEFAULT_P,
	});
	const salt = options.salt ? Buffer.from(options.salt) : randomBytes(SALT_LENGTH);
	if (salt.byteLength < SALT_LENGTH || salt.byteLength > 64) {
		throw new Error("Scrypt salt must contain between 16 and 64 bytes.");
	}
	const derived = await scrypt(password, salt, params);
	return [
		FORMAT,
		VERSION,
		`N=${params.N},r=${params.r},p=${params.p}`,
		salt.toString("base64url"),
		derived.toString("base64url"),
	].join("$");
}

/** Performs a full scrypt calculation before comparing the derived key. */
export async function verifyScryptPassword(
	password: string,
	encoded: string,
): Promise<boolean> {
	if (typeof password !== "string" || password.length > 1_024) return false;
	const parsed = parsePasswordHash(encoded);
	const candidate = parsed ?? parsePasswordHash(dummyScryptPasswordHash());
	if (!candidate) throw new Error("Internal dummy scrypt record is invalid.");
	try {
		const actual = await scrypt(password, candidate.salt, candidate);
		const matches = actual.byteLength === candidate.digest.byteLength
			&& timingSafeEqual(actual, candidate.digest);
		return parsed !== null && matches;
	} catch {
		return false;
	}
}

/** A valid but deliberately non-matching record for unknown-account checks. */
export function dummyScryptPasswordHash(): string {
	return [
		FORMAT,
		VERSION,
		`N=${DEFAULT_N},r=${DEFAULT_R},p=${DEFAULT_P}`,
		Buffer.alloc(SALT_LENGTH).toString("base64url"),
		Buffer.alloc(KEY_LENGTH).toString("base64url"),
	].join("$");
}

interface ScryptParams {
	N: number;
	r: number;
	p: number;
}

interface ParsedPasswordHash extends ScryptParams {
	salt: Buffer;
	digest: Buffer;
}

function parsePasswordHash(value: string): ParsedPasswordHash | null {
	if (typeof value !== "string") return null;
	const parts = value.split("$");
	if (parts.length !== 5 || parts[0] !== FORMAT || parts[1] !== VERSION) return null;
	const match = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(parts[2] ?? "");
	if (!match) return null;
	try {
		const params = validateParams({
			N: Number(match[1]),
			r: Number(match[2]),
			p: Number(match[3]),
		});
		const salt = Buffer.from(parts[3] ?? "", "base64url");
		const digest = Buffer.from(parts[4] ?? "", "base64url");
		if (salt.byteLength < SALT_LENGTH || salt.byteLength > 64) return null;
		if (digest.byteLength !== KEY_LENGTH) return null;
		return { ...params, salt, digest };
	} catch {
		return null;
	}
}

function validateParams(params: ScryptParams): ScryptParams {
	const { N, r, p } = params;
	if (
		!Number.isSafeInteger(N)
		|| N < DEFAULT_N
		|| N > 1_048_576
		|| (N & (N - 1)) !== 0
		|| !Number.isSafeInteger(r)
		|| r < 8
		|| r > 32
		|| !Number.isSafeInteger(p)
		|| p < 1
		|| p > 8
	) {
		throw new Error("Unsafe scrypt password parameters.");
	}
	return params;
}

function scrypt(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
	const maxmem = Math.max(64 * 1024 * 1024, 256 * params.N * params.r);
	return new Promise((resolve, reject) => {
		nodeScrypt(
			password,
			salt,
			KEY_LENGTH,
			{ N: params.N, r: params.r, p: params.p, maxmem },
			(error, derivedKey) => {
				if (error) reject(error);
				else resolve(derivedKey);
			},
		);
	});
}

function assertPassword(password: string): void {
	if (typeof password !== "string" || password.length < 1 || password.length > 1_024) {
		throw new Error("Password must contain between 1 and 1024 characters.");
	}
}
