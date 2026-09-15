/** Reject duplicate object keys before JSON.parse can overwrite one. */
export function parseRTWHistoryJSON(raw: string): unknown {
	const scanner = new JSONKeyScanner(raw);
	scanner.scan();
	return JSON.parse(raw);
}

class JSONKeyScanner {
	private cursor = 0;

	constructor(private readonly raw: string) {}

	scan(): void {
		this.value();
		this.whitespace();
		if (this.cursor !== this.raw.length) throw new SyntaxError("trailing JSON");
	}

	private value(): void {
		this.whitespace();
		switch (this.raw[this.cursor]) {
			case "{":
				this.object();
				return;
			case "[":
				this.array();
				return;
			case '"':
				this.string();
				return;
			case "t":
				this.literal("true");
				return;
			case "f":
				this.literal("false");
				return;
			case "n":
				this.literal("null");
				return;
			default:
				this.number();
		}
	}

	private object(): void {
		this.cursor++;
		this.whitespace();
		const seen = new Set<string>();
		if (this.raw[this.cursor] === "}") {
			this.cursor++;
			return;
		}
		for (;;) {
			if (this.raw[this.cursor] !== '"')
				throw new SyntaxError("object key required");
			const key = this.string();
			if (seen.has(key)) throw new SyntaxError("duplicate JSON object key");
			seen.add(key);
			this.whitespace();
			this.consume(":");
			this.value();
			this.whitespace();
			if (this.raw[this.cursor] === "}") {
				this.cursor++;
				return;
			}
			this.consume(",");
			this.whitespace();
		}
	}

	private array(): void {
		this.cursor++;
		this.whitespace();
		if (this.raw[this.cursor] === "]") {
			this.cursor++;
			return;
		}
		for (;;) {
			this.value();
			this.whitespace();
			if (this.raw[this.cursor] === "]") {
				this.cursor++;
				return;
			}
			this.consume(",");
		}
	}

	private string(): string {
		const start = this.cursor;
		this.cursor++;
		for (; this.cursor < this.raw.length; this.cursor++) {
			const character = this.raw[this.cursor];
			if (character === "\\") {
				this.cursor++;
				continue;
			}
			if (character === '"') {
				this.cursor++;
				return JSON.parse(this.raw.slice(start, this.cursor));
			}
		}
		throw new SyntaxError("unterminated JSON string");
	}

	private literal(expected: string): void {
		if (!this.raw.startsWith(expected, this.cursor))
			throw new SyntaxError("invalid JSON literal");
		this.cursor += expected.length;
	}

	private number(): void {
		const remaining = this.raw.slice(this.cursor);
		const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(
			remaining,
		);
		if (!match) throw new SyntaxError("invalid JSON value");
		this.cursor += match[0].length;
	}

	private consume(expected: string): void {
		if (this.raw[this.cursor] !== expected)
			throw new SyntaxError("invalid JSON separator");
		this.cursor++;
	}

	private whitespace(): void {
		while (/^[\t\n\r ]$/u.test(this.raw[this.cursor] ?? "")) this.cursor++;
	}
}
