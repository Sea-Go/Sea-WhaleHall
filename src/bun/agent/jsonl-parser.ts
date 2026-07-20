export class JsonlProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "JsonlProtocolError";
	}
}

export class JsonlParser {
	private buffer = new Uint8Array(0);
	private readonly decoder = new TextDecoder("utf-8", { fatal: true });

	constructor(
		private readonly onLine: (line: string) => void,
		private readonly maxLineBytes: number,
	) {}

	feed(chunk: Uint8Array): void {
		if (chunk.byteLength === 0) return;
		const merged = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
		merged.set(this.buffer);
		merged.set(chunk, this.buffer.byteLength);

		let lineStart = 0;
		for (let index = 0; index < merged.byteLength; index += 1) {
			if (merged[index] !== 0x0a) continue;
			this.emitBytes(merged.subarray(lineStart, index));
			lineStart = index + 1;
		}

		this.buffer = merged.slice(lineStart);
		if (this.buffer.byteLength > this.maxLineBytes) {
			throw new JsonlProtocolError(
				`JSONL line exceeded ${this.maxLineBytes} bytes before a newline.`,
			);
		}
	}

	finish(): void {
		if (this.buffer.byteLength > 0) this.emitBytes(this.buffer);
		this.buffer = new Uint8Array(0);
	}

	reset(): void {
		this.buffer = new Uint8Array(0);
	}

	private emitBytes(bytes: Uint8Array): void {
		const lineBytes = bytes.at(-1) === 0x0d ? bytes.subarray(0, -1) : bytes;
		if (lineBytes.byteLength > this.maxLineBytes) {
			throw new JsonlProtocolError(`JSONL line exceeded ${this.maxLineBytes} bytes.`);
		}
		try {
			this.onLine(this.decoder.decode(lineBytes));
		} catch (error) {
			if (error instanceof JsonlProtocolError) throw error;
			throw new JsonlProtocolError(
				error instanceof Error ? error.message : String(error),
			);
		}
	}
}
