import { TextDecoder } from "node:util";

const headerTerminator = Buffer.from("\r\n\r\n", "ascii");
const contentLengthPattern = /^content-length:\s*(\d+)\s*$/i;

export const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_HEADER_BYTES = 8 * 1024;

export class ContentLengthProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ContentLengthProtocolError";
	}
}

export function encodeContentLengthFrame(value: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(value), "utf8");
	const header = Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "ascii");
	return Buffer.concat([header, body]);
}

export class ContentLengthFrameParser {
	private buffer = Buffer.alloc(0);
	private expectedBodyBytes: number | null = null;
	private readonly decoder = new TextDecoder("utf-8", { fatal: true });

	constructor(
		private readonly maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
		private readonly maxHeaderBytes = DEFAULT_MAX_HEADER_BYTES,
	) {
		if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
			throw new RangeError("maxFrameBytes must be a positive safe integer.");
		}
		if (!Number.isSafeInteger(maxHeaderBytes) || maxHeaderBytes < 1) {
			throw new RangeError("maxHeaderBytes must be a positive safe integer.");
		}
	}

	push(chunk: Uint8Array): unknown[] {
		if (chunk.byteLength === 0) return [];
		this.buffer = Buffer.concat([
			this.buffer,
			Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength),
		]);
		const frames: unknown[] = [];

		while (true) {
			if (this.expectedBodyBytes === null) {
				const headerEnd = this.buffer.indexOf(headerTerminator);
				if (headerEnd < 0) {
					if (this.buffer.byteLength > this.maxHeaderBytes) {
						throw new ContentLengthProtocolError(
							`Frame header exceeds ${this.maxHeaderBytes} bytes.`,
						);
					}
					break;
				}
				if (headerEnd > this.maxHeaderBytes) {
					throw new ContentLengthProtocolError(
						`Frame header exceeds ${this.maxHeaderBytes} bytes.`,
					);
				}
				this.expectedBodyBytes = parseContentLength(
					this.buffer.subarray(0, headerEnd).toString("ascii"),
					this.maxFrameBytes,
				);
				this.buffer = this.buffer.subarray(headerEnd + headerTerminator.byteLength);
			}

			if (this.buffer.byteLength < this.expectedBodyBytes) break;
			const body = this.buffer.subarray(0, this.expectedBodyBytes);
			this.buffer = this.buffer.subarray(this.expectedBodyBytes);
			this.expectedBodyBytes = null;

			let text: string;
			try {
				text = this.decoder.decode(body);
			} catch (error) {
				throw new ContentLengthProtocolError(
					`Frame body is not valid UTF-8: ${errorMessage(error)}`,
				);
			}
			try {
				frames.push(JSON.parse(text) as unknown);
			} catch (error) {
				throw new ContentLengthProtocolError(
					`Frame body is not valid JSON: ${errorMessage(error)}`,
				);
			}
		}

		return frames;
	}

	finish(): void {
		if (this.expectedBodyBytes !== null || this.buffer.byteLength > 0) {
			throw new ContentLengthProtocolError("Input ended with an incomplete frame.");
		}
	}
}

function parseContentLength(header: string, maxFrameBytes: number): number {
	let contentLength: number | null = null;
	for (const line of header.split("\r\n")) {
		const match = contentLengthPattern.exec(line);
		if (!match) continue;
		if (contentLength !== null) {
			throw new ContentLengthProtocolError("Frame has duplicate Content-Length headers.");
		}
		const parsed = Number(match[1]);
		if (!Number.isSafeInteger(parsed)) {
			throw new ContentLengthProtocolError("Content-Length is not a safe integer.");
		}
		contentLength = parsed;
	}
	if (contentLength === null) {
		throw new ContentLengthProtocolError("Frame is missing a Content-Length header.");
	}
	if (contentLength > maxFrameBytes) {
		throw new ContentLengthProtocolError(
			`Frame body exceeds ${maxFrameBytes} bytes.`,
		);
	}
	return contentLength;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
