export interface ReflectionHasher {
	sha256(value: string): Promise<string>;
}

export class WebCryptoReflectionHasher implements ReflectionHasher {
	async sha256(value: string): Promise<string> {
		const bytes = new TextEncoder().encode(value);
		const digest = await crypto.subtle.digest("SHA-256", bytes);
		return Array.from(new Uint8Array(digest), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
	}
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(toCanonicalValue(value));
}

function toCanonicalValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(toCanonicalValue);
	if (typeof value !== "object" || value === null) return value;

	const record = value as Record<string, unknown>;
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(record).sort()) {
		const entry = record[key];
		if (entry !== undefined) result[key] = toCanonicalValue(entry);
	}
	return result;
}
