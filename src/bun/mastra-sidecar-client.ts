import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	ContentLengthFrameParser,
	encodeContentLengthFrame,
} from "../agent/mastra-host/framing";
import {
	AGENT_HOST_PROTOCOL_VERSION,
	type AgentHostErrorPayload,
	type AgentHostMethod,
	type AgentRunEventFrame,
	isAgentRunEventFrame,
	isProtocolResponse,
	isSidecarHostRequest,
	type ModelRelayEventFrame,
	type ProtocolMessage,
	type RuntimeInitializeParams,
	type RuntimeInitializeResult,
	type SidecarHostMethod,
} from "../agent/mastra-host/protocol";
import { ModelRelayError } from "./model-relay-transport";

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 35_000;
const RESTART_DELAYS_MS = [1_000, 5_000, 15_000] as const;

interface PendingRequest {
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
	removeAbortListener(): void;
}

export interface SidecarHostCall {
	requestId: string;
	method: SidecarHostMethod;
	params: Record<string, unknown>;
}

export interface MastraSidecarClientOptions {
	nodePath: string;
	entryPath: string;
	initialize: RuntimeInitializeParams;
	requestTimeoutMs?: number;
	initializeTimeoutMs?: number;
	onHostCall(call: SidecarHostCall): Promise<unknown>;
	onRunEvent(event: AgentRunEventFrame): void;
	onInterrupted?(runIds: readonly string[], reason: string): void;
	onRestarted?(): void;
	spawnProcess?: typeof spawn;
}

export class MastraSidecarError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly retryable = false,
	) {
		super(message);
		this.name = "MastraSidecarError";
	}
}

/** Supervises the packaged Node sidecar without opening a local port. */
export class MastraSidecarClient {
	private child: ChildProcessWithoutNullStreams | null = null;
	private parser = new ContentLengthFrameParser(MAX_FRAME_BYTES);
	private readonly pending = new Map<string, PendingRequest>();
	private readonly activeRunIds = new Set<string>();
	private startPromise: Promise<RuntimeInitializeResult> | null = null;
	private stopping = false;
	private restartTimer: ReturnType<typeof setTimeout> | null = null;
	private restartAttempt = 0;
	private writerTail = Promise.resolve();
	private acceptTail = Promise.resolve();

	constructor(private readonly options: MastraSidecarClientOptions) {}

	start(): Promise<RuntimeInitializeResult> {
		if (this.startPromise) return this.startPromise;
		if (this.restartTimer) clearTimeout(this.restartTimer);
		this.restartTimer = null;
		this.stopping = false;
		const operation = this.spawnAndInitialize();
		this.startPromise = operation;
		void operation.catch(() => {
			if (this.startPromise === operation) this.startPromise = null;
			this.scheduleRestart();
		});
		return operation;
	}

	async stop(): Promise<void> {
		this.stopping = true;
		if (this.restartTimer) clearTimeout(this.restartTimer);
		this.restartTimer = null;
		const child = this.child;
		if (!child) {
			this.startPromise = null;
			this.resetTransportState();
			return;
		}
		try {
			await this.request("runtime.shutdown", {});
		} catch {}
		if (
			this.child !== child ||
			child.exitCode !== null ||
			child.signalCode !== null
		) {
			this.startPromise = null;
			return;
		}
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				child.kill();
				resolve();
			}, 2_000);
			child.once("close", () => {
				clearTimeout(timer);
				resolve();
			});
		});
		if (this.child === child) this.handleExit(child, "Agent Sidecar stopped.");
	}

	async request<TResult = unknown>(
		method: AgentHostMethod,
		params: Record<string, unknown>,
		options: {
			requestId?: string;
			timeoutMs?: number;
			signal?: AbortSignal;
		} = {},
	): Promise<TResult> {
		if (options.signal?.aborted) throw cancelledRequestError();
		if (!this.child) await awaitAbortable(this.start(), options.signal);
		if (options.signal?.aborted) throw cancelledRequestError();
		const requestId = options.requestId ?? `bun:${randomUUID()}`;
		if (this.pending.has(requestId)) {
			throw new MastraSidecarError(
				"DUPLICATE_REQUEST",
				"重复的 Sidecar requestId。",
				false,
			);
		}
		const result = new Promise<TResult>((resolve, reject) => {
			const timer = setTimeout(
				() => {
					this.rejectPending(
						requestId,
						new MastraSidecarError(
							"TIMEOUT",
							"本地 Agent Sidecar 响应超时。",
							true,
						),
					);
				},
				options.timeoutMs ??
					this.options.requestTimeoutMs ??
					DEFAULT_REQUEST_TIMEOUT_MS,
			);
			let removeAbortListener = () => {};
			const pending: PendingRequest = {
				resolve: (value) => resolve(value as TResult),
				reject,
				timer,
				removeAbortListener: () => removeAbortListener(),
			};
			this.pending.set(requestId, pending);
			if (options.signal) {
				const onAbort = () =>
					this.rejectPending(requestId, cancelledRequestError());
				removeAbortListener = () =>
					options.signal?.removeEventListener("abort", onAbort);
				options.signal.addEventListener("abort", onAbort, { once: true });
				if (options.signal.aborted) onAbort();
			}
		});
		if (!this.pending.has(requestId)) return result;
		try {
			await this.write({
				protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
				type: "request",
				requestId,
				method,
				params,
			} as ProtocolMessage);
		} catch (error) {
			this.rejectPending(requestId, asError(error));
		}
		return result;
	}

	trackRun(runId: string): void {
		this.activeRunIds.add(runId);
	}

	untrackRun(runId: string): void {
		this.activeRunIds.delete(runId);
	}

	sendRelayEvent(event: ModelRelayEventFrame): Promise<void> {
		return this.write(event);
	}

	private async spawnAndInitialize(): Promise<RuntimeInitializeResult> {
		if (this.child)
			throw new MastraSidecarError("ALREADY_RUNNING", "Agent Sidecar 已启动。");
		this.parser = new ContentLengthFrameParser(MAX_FRAME_BYTES);
		this.acceptTail = Promise.resolve();
		const spawnProcess = this.options.spawnProcess ?? spawn;
		const child = spawnProcess(
			this.options.nodePath,
			[this.options.entryPath],
			{
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
				env: safeSidecarEnvironment(),
			},
		);
		this.child = child;
		child.stdout.on("data", (chunk: Buffer) => this.acceptBytes(child, chunk));
		// Consume stderr to avoid a blocked pipe, but never copy potentially
		// sensitive model context into application logs or crash reports.
		child.stderr.on("data", () => {});
		child.once("error", (error) => this.handleExit(child, error.message));
		child.once("close", (code, signal) => {
			this.handleExit(
				child,
				`Agent Sidecar exited (${signal ?? code ?? "unknown"}).`,
			);
		});

		try {
			const initialized = await this.request<RuntimeInitializeResult>(
				"runtime.initialize",
				this.options.initialize as unknown as Record<string, unknown>,
				{ timeoutMs: this.options.initializeTimeoutMs ?? 20_000 },
			);
			if (
				initialized.protocolVersion !== AGENT_HOST_PROTOCOL_VERSION ||
				initialized.capabilities.listensOnNetwork !== false
			) {
				throw new MastraSidecarError(
					"CAPABILITY_MISMATCH",
					"本地 Agent Sidecar 能力不符合安全要求。",
				);
			}
			this.restartAttempt = 0;
			return initialized;
		} catch (error) {
			this.handleExit(
				child,
				error instanceof Error
					? `Agent Sidecar initialization failed: ${error.message}`
					: "Agent Sidecar initialization failed.",
			);
			throw error;
		}
	}

	private acceptBytes(
		child: ChildProcessWithoutNullStreams,
		chunk: Uint8Array,
	): void {
		if (this.child !== child) return;
		try {
			const messages = this.parser.push(chunk);
			this.acceptTail = this.acceptTail
				.then(async () => {
					if (this.child !== child) return;
					for (const message of messages) await this.accept(child, message);
				})
				.catch((error) => this.failProtocol(child, error));
		} catch (error) {
			this.failProtocol(child, error);
		}
	}

	private async accept(
		child: ChildProcessWithoutNullStreams,
		message: unknown,
	): Promise<void> {
		if (this.child !== child) return;
		if (
			!isRecord(message) ||
			message.protocolVersion !== AGENT_HOST_PROTOCOL_VERSION
		) {
			throw new MastraSidecarError(
				"INVALID_FRAME",
				"Sidecar 返回了无效协议帧。",
			);
		}
		if (message.type === "response") {
			if (!isProtocolResponse(message)) {
				throw new MastraSidecarError(
					"INVALID_RESPONSE",
					"Sidecar response shape 无效。",
				);
			}
			this.acceptResponse(message);
			return;
		}
		if (message.type === "event") {
			if (!isAgentRunEventFrame(message)) {
				throw new MastraSidecarError(
					"INVALID_EVENT",
					"Sidecar event shape 无效。",
				);
			}
			this.options.onRunEvent(message);
			if (message.terminalState) this.untrackRun(message.runId);
			return;
		}
		if (message.type === "request") {
			if (!isSidecarHostRequest(message)) {
				throw new MastraSidecarError(
					"INVALID_REQUEST",
					"Sidecar host call shape 无效。",
				);
			}
			await this.acceptHostCall(child, message);
			return;
		}
		throw new MastraSidecarError(
			"INVALID_FRAME",
			"Sidecar 返回了未知协议消息。",
		);
	}

	private acceptResponse(message: Record<string, unknown>): void {
		if (
			typeof message.requestId !== "string" ||
			typeof message.ok !== "boolean"
		) {
			throw new MastraSidecarError(
				"INVALID_RESPONSE",
				"Sidecar response shape 无效。",
			);
		}
		const pending = this.pending.get(message.requestId);
		if (!pending) return;
		this.pending.delete(message.requestId);
		clearTimeout(pending.timer);
		pending.removeAbortListener();
		if (message.ok) pending.resolve(message.result);
		else pending.reject(protocolError(message.error));
	}

	private failProtocol(
		child: ChildProcessWithoutNullStreams,
		error: unknown,
	): void {
		if (this.child !== child) return;
		const reason =
			error instanceof Error ? error.message : "Sidecar 协议错误。";
		this.handleExit(child, reason);
	}

	private async acceptHostCall(
		child: ChildProcessWithoutNullStreams,
		message: Record<string, unknown>,
	): Promise<void> {
		const requestId =
			typeof message.requestId === "string"
				? message.requestId
				: "invalid-request";
		try {
			if (typeof message.method !== "string" || !isRecord(message.params)) {
				throw new MastraSidecarError(
					"INVALID_REQUEST",
					"Sidecar host call shape 无效。",
				);
			}
			const result = await this.options.onHostCall({
				requestId,
				method: message.method as SidecarHostMethod,
				params: message.params,
			});
			if (this.child !== child) return;
			await this.write(
				{
					protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
					type: "response",
					requestId,
					ok: true,
					result,
				} as ProtocolMessage,
				child,
			);
		} catch (error) {
			if (this.child !== child) return;
			const failure = errorPayload(error);
			await this.write(
				{
					protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
					type: "response",
					requestId,
					ok: false,
					error: failure,
				} as ProtocolMessage,
				child,
			);
		}
	}

	private write(
		message: ProtocolMessage,
		expectedChild?: ChildProcessWithoutNullStreams,
	): Promise<void> {
		const child = expectedChild ?? this.child;
		if (!child || this.child !== child || child.stdin.destroyed) {
			return Promise.reject(
				new MastraSidecarError("NOT_RUNNING", "Agent Sidecar 未运行。", true),
			);
		}
		const frame = encodeContentLengthFrame(message);
		const operation = this.writerTail
			.catch(() => undefined)
			.then(
				() =>
					new Promise<void>((resolve, reject) => {
						if (this.child !== child || child.stdin.destroyed) {
							reject(
								new MastraSidecarError(
									"NOT_RUNNING",
									"Agent Sidecar 未运行。",
									true,
								),
							);
							return;
						}
						child.stdin.write(frame, (error) =>
							error ? reject(error) : resolve(),
						);
					}),
			);
		this.writerTail = operation;
		return operation;
	}

	private handleExit(
		child: ChildProcessWithoutNullStreams,
		reason: string,
	): void {
		if (this.child !== child) return;
		this.child = null;
		this.startPromise = null;
		const error = new MastraSidecarError(
			"INTERRUPTED",
			"本地 Agent 进程已中断。",
			true,
		);
		for (const requestId of [...this.pending.keys()])
			this.rejectPending(requestId, error);
		this.resetTransportState();
		child.stdin.destroy();
		child.stdout.destroy();
		child.stderr.destroy();
		if (child.exitCode === null && child.signalCode === null) {
			try {
				child.kill();
			} catch {}
		}
		const runIds = [...this.activeRunIds];
		this.activeRunIds.clear();
		// The callback also owns relay cleanup, so it must run even when a crash
		// happens before a run has been registered in activeRunIds.
		this.options.onInterrupted?.(runIds, reason);
		this.scheduleRestart();
	}

	private resetTransportState(): void {
		this.parser = new ContentLengthFrameParser(MAX_FRAME_BYTES);
		this.writerTail = Promise.resolve();
		this.acceptTail = Promise.resolve();
	}

	private scheduleRestart(): void {
		if (this.stopping || this.restartTimer || this.child) return;
		const delay =
			RESTART_DELAYS_MS[
				Math.min(this.restartAttempt, RESTART_DELAYS_MS.length - 1)
			]!;
		this.restartAttempt += 1;
		this.restartTimer = setTimeout(() => {
			this.restartTimer = null;
			void this.start()
				.then(() => this.options.onRestarted?.())
				.catch(() => undefined);
		}, delay);
	}

	private rejectPending(requestId: string, error: Error): void {
		const pending = this.pending.get(requestId);
		if (!pending) return;
		this.pending.delete(requestId);
		clearTimeout(pending.timer);
		pending.removeAbortListener();
		pending.reject(error);
	}
}

export function safeSidecarEnvironment(): NodeJS.ProcessEnv {
	const allowed = [
		"PATH",
		"Path",
		"SYSTEMROOT",
		"SystemRoot",
		"WINDIR",
		"TEMP",
		"TMP",
		"LANG",
		"LC_ALL",
		"SSL_CERT_FILE",
		"SSL_CERT_DIR",
		"NODE_EXTRA_CA_CERTS",
	] as const;
	const output: NodeJS.ProcessEnv = {
		NODE_ENV: process.env.NODE_ENV ?? "production",
		// Mastra ships anonymous PostHog telemetry enabled by default. The local
		// Agent must never emit it, even if the parent desktop environment differs.
		MASTRA_TELEMETRY_DISABLED: "1",
	};
	for (const name of allowed) {
		const value = process.env[name];
		if (value !== undefined) output[name] = value;
	}
	return output;
}

function protocolError(value: unknown): MastraSidecarError {
	if (!isRecord(value))
		return new MastraSidecarError(
			"INTERNAL_ERROR",
			"Sidecar 返回了无效错误。",
			false,
		);
	return new MastraSidecarError(
		typeof value.code === "string" ? value.code : "INTERNAL_ERROR",
		typeof value.message === "string" ? value.message : "Sidecar 请求失败。",
		value.retryable === true,
	);
}

function errorPayload(error: unknown): AgentHostErrorPayload {
	if (error instanceof ModelRelayError) {
		return {
			code:
				error.code === "cancelled"
					? "CANCELLED"
					: error.code === "service-unavailable"
						? "MODEL_RELAY_UNAVAILABLE"
						: "MODEL_RELAY_ERROR",
			message: error.message,
			retryable: error.code === "remote-failure" || error.code === "cancelled",
		};
	}
	if (error instanceof MastraSidecarError) {
		return {
			code: error.code === "CANCELLED" ? "CANCELLED" : "INTERNAL_ERROR",
			message: error.message,
			retryable: error.retryable,
		};
	}
	return {
		code: "INTERNAL_ERROR",
		message: error instanceof Error ? error.message : "Bun host call failed.",
		retryable: false,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function cancelledRequestError(): MastraSidecarError {
	return new MastraSidecarError(
		"CANCELLED",
		"本地 Agent Sidecar 请求已取消。",
		true,
	);
}

function awaitAbortable<TResult>(
	operation: Promise<TResult>,
	signal: AbortSignal | undefined,
): Promise<TResult> {
	if (!signal) return operation;
	if (signal.aborted) return Promise.reject(cancelledRequestError());
	return new Promise<TResult>((resolve, reject) => {
		let settled = false;
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(cancelledRequestError());
		};
		signal.addEventListener("abort", onAbort, { once: true });
		void operation.then(
			(value) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			},
		);
		if (signal.aborted) onAbort();
	});
}
