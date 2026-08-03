import { once } from "node:events";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import type { ModelRelayHandler } from "./server.js";

export interface NodeModelRelayServerOptions {
	host?: string;
	port?: number;
}

/**
 * Adapts the Web Request/Response handler to Node HTTP. Response writes await
 * `drain`, so a slow desktop client applies backpressure to the provider body.
 */
export function createNodeModelRelayServer(handler: ModelRelayHandler): Server {
	const server = createServer(async (incoming, outgoing) => {
		const abort = new AbortController();
		const abortRequest = () => abort.abort(new DOMException("Client disconnected.", "AbortError"));
		incoming.once("aborted", abortRequest);
		outgoing.once("close", () => {
			if (!outgoing.writableEnded) abortRequest();
		});

		try {
			const request = toWebRequest(incoming, abort.signal);
			const response = await handler(request, {
				clientAddress: incoming.socket.remoteAddress,
			});
			await writeWebResponse(response, outgoing, abort);
		} catch {
			if (!outgoing.headersSent && !outgoing.destroyed) {
				outgoing.writeHead(500, {
					"content-type": "application/json; charset=utf-8",
					"cache-control": "no-store",
					"x-content-type-options": "nosniff",
				});
				outgoing.end('{"error":{"code":"internal-error","message":"The relay could not process the request."}}');
			} else if (!outgoing.destroyed) {
				outgoing.destroy();
			}
		}
	});
	server.headersTimeout = 10_000;
	server.requestTimeout = 30_000;
	server.keepAliveTimeout = 5_000;
	server.maxHeadersCount = 100;
	return server;
}

export async function listenNodeModelRelayServer(
	server: Server,
	options: NodeModelRelayServerOptions = {},
): Promise<void> {
	server.listen(options.port ?? 8787, options.host ?? "127.0.0.1");
	await once(server, "listening");
}

function toWebRequest(incoming: IncomingMessage, signal: AbortSignal): Request {
	const path = incoming.url ?? "/";
	if (!path.startsWith("/")) throw new Error("Invalid request target.");
	const headers = new Headers();
	for (const [name, value] of Object.entries(incoming.headers)) {
		if (Array.isArray(value)) {
			for (const item of value) headers.append(name, item);
		} else if (value !== undefined) {
			headers.set(name, value);
		}
	}
	const method = incoming.method ?? "GET";
	const hasBody = method !== "GET" && method !== "HEAD";
	const init: RequestInit & { duplex?: "half" } = {
		method,
		headers,
		signal,
	};
	if (hasBody) {
		init.body = Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>;
		init.duplex = "half";
	}
	return new Request(`http://relay.internal${path}`, init);
}

async function writeWebResponse(
	response: Response,
	outgoing: ServerResponse,
	abort: AbortController,
): Promise<void> {
	const headers: Record<string, string | string[]> = {};
	for (const [name, value] of response.headers) headers[name] = value;
	outgoing.writeHead(response.status, headers);
	if (!response.body) {
		outgoing.end();
		return;
	}

	const reader = response.body.getReader();
	try {
		while (!outgoing.destroyed) {
			const item = await reader.read();
			if (item.done) {
				outgoing.end();
				return;
			}
			if (!outgoing.write(Buffer.from(item.value))) {
				await waitForDrain(outgoing);
			}
		}
		throw new DOMException("Client disconnected.", "AbortError");
	} catch (error) {
		abort.abort(error);
		await reader.cancel(error).catch(() => {});
		if (!outgoing.destroyed) outgoing.destroy();
	} finally {
		reader.releaseLock();
	}
}

function waitForDrain(outgoing: ServerResponse): Promise<void> {
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			outgoing.off("drain", onDrain);
			outgoing.off("close", onClose);
			outgoing.off("error", onError);
		};
		const onDrain = () => {
			cleanup();
			resolve();
		};
		const onClose = () => {
			cleanup();
			reject(new DOMException("Client disconnected.", "AbortError"));
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		outgoing.once("drain", onDrain);
		outgoing.once("close", onClose);
		outgoing.once("error", onError);
	});
}
