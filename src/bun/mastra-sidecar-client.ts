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
const DEFAULT_SHUTDOWN_PROTOCOL_TIMEOUT_MS = 1_000;
const DEFAULT_SHUTDOWN_GRACE_TIMEOUT_MS = 500;
const DEFAULT_SHUTDOWN_TERMINATE_TIMEOUT_MS = 1_000;
const DEFAULT_SHUTDOWN_KILL_TIMEOUT_MS = 1_000;
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
	shutdownProtocolTimeoutMs?: number;
	shutdownGraceTimeoutMs?: number;
	shutdownTerminateTimeoutMs?: number;
	shutdownKillTimeoutMs?: number;
	onHostCall(call: SidecarHostCall): Promise<unknown>;
	onRunEvent(event: AgentRunEventFrame): void;
	onInterrupted?(
		runIds: readonly string[],
		reason: string,
	): void | Promise<void>;
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
	// A transport error can make a child unusable before Node confirms that its
	// stdio and process handle are closed. Keep every spawned child owned until
	// the close event so a later quit retry cannot mistake an orphan for success.
	private readonly ownedChildren = new Set<ChildProcessWithoutNullStreams>();
	private readonly closedChildren =
		new WeakSet<ChildProcessWithoutNullStreams>();
	private startPromise: Promise<RuntimeInitializeResult> | null = null;
	private stopPromise: Promise<void> | null = null;
	private stopping = false;
	private shutdownRequested = false;
	private restartTimer: ReturnType<typeof setTimeout> | null = null;
	private restartAttempt = 0;
	private writerTail = Promise.resolve();
	private acceptTail = Promise.resolve();
	private readonly acceptSettlements = new Set<Promise<void>>();
	private readonly interruptionQueue: Array<{
		runIds: readonly string[];
		reason: string;
	}> = [];
	private interruptionDrain: Promise<void> | null = null;
	private readonly shutdownProtocolTimeoutMs: number;
	private readonly shutdownGraceTimeoutMs: number;
	private readonly shutdownTerminateTimeoutMs: number;
	private readonly shutdownKillTimeoutMs: number;

	constructor(private readonly options: MastraSidecarClientOptions) {
		this.shutdownProtocolTimeoutMs = positiveShutdownTimeout(
			options.shutdownProtocolTimeoutMs,
			DEFAULT_SHUTDOWN_PROTOCOL_TIMEOUT_MS,
		);
		this.shutdownGraceTimeoutMs = positiveShutdownTimeout(
			options.shutdownGraceTimeoutMs,
			DEFAULT_SHUTDOWN_GRACE_TIMEOUT_MS,
		);
		this.shutdownTerminateTimeoutMs = positiveShutdownTimeout(
			options.shutdownTerminateTimeoutMs,
			DEFAULT_SHUTDOWN_TERMINATE_TIMEOUT_MS,
		);
		this.shutdownKillTimeoutMs = positiveShutdownTimeout(
			options.shutdownKillTimeoutMs,
			DEFAULT_SHUTDOWN_KILL_TIMEOUT_MS,
		);
	}

	get isRunning(): boolean {
		return this.child !== null;
	}

	/** Permanently prevents late requests or restart during application quit. */
	beginShutdown(): void {
		this.shutdownRequested = true;
		this.stopping = true;
		if (this.restartTimer) clearTimeout(this.restartTimer);
		this.restartTimer = null;
	}

	start(): Promise<RuntimeInitializeResult> {
		if (this.shutdownRequested) return Promise.reject(sidecarShutdownError());
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

	stop(): Promise<void> {
		// This is an application-lifetime latch. A later stop attempt may retry
		// ownership reconciliation, but no request may restart the sidecar.
		this.beginShutdown();
		if (this.stopPromise) return this.stopPromise;
		const operation = this.stopOwnedChild();
		this.stopPromise = operation;
		void operation.then(
			() => {
				if (this.stopPromise === operation) this.stopPromise = null;
			},
			() => {
				if (this.stopPromise === operation) this.stopPromise = null;
			},
		);
		return operation;
	}

	private async stopOwnedChild(): Promise<void> {
		this.stopping = true;
		if (this.restartTimer) clearTimeout(this.restartTimer);
		this.restartTimer = null;
		const activeChild = this.child;
		const children = [...this.ownedChildren];
		if (children.length === 0) {
			this.startPromise = null;
			this.resetTransportState();
			await this.drainAcceptedFrames();
			await this.drainInterruptions();
			return;
		}
		const outcomes = await Promise.allSettled(
			children.map((child) => this.stopChild(child, child === activeChild)),
		);
		const dependentOutcomes = await Promise.allSettled([
			this.drainAcceptedFrames(),
			this.drainInterruptions(),
		]);
		if (
			outcomes.some((outcome) => outcome.status === "rejected") ||
			dependentOutcomes.some((outcome) => outcome.status === "rejected")
		) {
			throw new MastraSidecarError(
				"STOP_FAILED",
				"本地 Agent Sidecar 未能完成退出与中断状态持久化。",
				false,
			);
		}
	}

	/** Joins every inbound frame dispatch accepted before the fixed point. */
	private async drainAcceptedFrames(): Promise<void> {
		for (;;) {
			const accepted = [...this.acceptSettlements];
			if (accepted.length === 0) return;
			await Promise.allSettled(accepted);
		}
	}

	/** Joins every run-interruption callback accepted before the fixed point. */
	drainInterruptions(): Promise<void> {
		if (this.interruptionDrain !== null) return this.interruptionDrain;
		const operation = (async () => {
			for (;;) {
				const interruption = this.interruptionQueue[0];
				if (interruption === undefined) return;
				// Retain the exact head until it succeeds. A transient repository/keychain
				// failure therefore blocks this shutdown attempt but can be retried by the
				// next stop instead of permanently poisoning process exit.
				await this.options.onInterrupted?.(
					interruption.runIds,
					interruption.reason,
				);
				if (this.interruptionQueue[0] === interruption) {
					this.interruptionQueue.shift();
				}
			}
		})().finally(() => {
			if (this.interruptionDrain === operation) {
				this.interruptionDrain = null;
			}
		});
		this.interruptionDrain = operation;
		return operation;
	}

	private async stopChild(
		child: ChildProcessWithoutNullStreams,
		requestProtocolShutdown: boolean,
	): Promise<void> {
		if (requestProtocolShutdown) {
			const controller = new AbortController();
			try {
				await this.withShutdownDeadline(
					this.requestInternal(
						"runtime.shutdown",
						{},
						{
							timeoutMs: this.shutdownProtocolTimeoutMs,
							signal: controller.signal,
						},
						true,
					),
					this.shutdownProtocolTimeoutMs,
				);
			} catch {
				// A stuck ordered request can keep runtime.shutdown behind it. Process
				// termination below is the bounded recovery path.
			} finally {
				controller.abort();
			}
		}
		if (await this.waitForConfirmedClose(child, this.shutdownGraceTimeoutMs)) {
			return;
		}

		this.signalChild(child, "SIGTERM");
		if (
			await this.waitForConfirmedClose(child, this.shutdownTerminateTimeoutMs)
		) {
			return;
		}

		this.signalChild(child, "SIGKILL");
		if (await this.waitForConfirmedClose(child, this.shutdownKillTimeoutMs)) {
			return;
		}
		throw new Error("sidecar close was not confirmed");
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
		return this.requestInternal(method, params, options, false);
	}

	private async requestInternal<TResult = unknown>(
		method: AgentHostMethod,
		params: Record<string, unknown>,
		options: {
			requestId?: string;
			timeoutMs?: number;
			signal?: AbortSignal;
		},
		allowDuringShutdown: boolean,
	): Promise<TResult> {
		if (this.shutdownRequested && !allowDuringShutdown) {
			throw sidecarShutdownError();
		}
		if (options.signal?.aborted) throw cancelledRequestError();
		if (!this.child) {
			if (allowDuringShutdown) throw sidecarShutdownError();
			await awaitAbortable(this.start(), options.signal);
		}
		if (this.shutdownRequested && !allowDuringShutdown) {
			throw sidecarShutdownError();
		}
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
		if (this.shutdownRequested) return Promise.reject(sidecarShutdownError());
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
		this.ownedChildren.add(child);
		this.child = child;
		child.stdout.on("data", (chunk: Buffer) => this.acceptBytes(child, chunk));
		// Consume stderr to avoid a blocked pipe, but never copy potentially
		// sensitive model context into application logs or crash reports.
		child.stderr.on("data", () => {});
		child.once("error", (error) => this.handleExit(child, error.message));
		child.once("close", (code, signal) => {
			this.closedChildren.add(child);
			this.ownedChildren.delete(child);
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
			const operation = this.acceptTail
				.then(async () => {
					if (this.child !== child) return;
					for (const message of messages) await this.accept(child, message);
				})
				.catch((error) => this.failProtocol(child, error));
			this.acceptTail = operation;
			this.acceptSettlements.add(operation);
			void operation
				.finally(() => this.acceptSettlements.delete(operation))
				.catch(() => undefined);
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
			if (this.shutdownRequested) return;
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
			if (this.shutdownRequested) throw sidecarShutdownError();
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
		this.interruptionQueue.push({ runIds, reason });
		void this.drainInterruptions().catch(() => undefined);
		this.scheduleRestart();
	}

	private signalChild(
		child: ChildProcessWithoutNullStreams,
		signal: NodeJS.Signals,
	): void {
		try {
			child.kill(signal);
		} catch {
			// A failed signal is followed by the same confirmed-close deadline. The
			// caller reports STOP_FAILED if ownership cannot be safely released.
		}
	}

	private async waitForConfirmedClose(
		child: ChildProcessWithoutNullStreams,
		timeoutMs: number,
	): Promise<boolean> {
		if (this.closedChildren.has(child)) return true;
		return new Promise<boolean>((resolve) => {
			let settled = false;
			const finish = (closed: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				child.removeListener("close", onClose);
				resolve(closed);
			};
			const onClose = () => finish(true);
			const timer = setTimeout(() => finish(false), timeoutMs);
			child.once("close", onClose);
			if (this.closedChildren.has(child)) finish(true);
		});
	}

	private async withShutdownDeadline<TResult>(
		operation: Promise<TResult>,
		timeoutMs: number,
	): Promise<TResult> {
		return new Promise<TResult>((resolve, reject) => {
			let settled = false;
			const finish = (
				outcome:
					| { kind: "completed"; value: TResult }
					| { kind: "failed"; error: unknown }
					| { kind: "timed_out" },
			) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (outcome.kind === "completed") resolve(outcome.value);
				else if (outcome.kind === "failed") reject(outcome.error);
				else
					reject(
						new MastraSidecarError(
							"SHUTDOWN_TIMEOUT",
							"本地 Agent Sidecar 关闭请求超时。",
							true,
						),
					);
			};
			const timer = setTimeout(() => finish({ kind: "timed_out" }), timeoutMs);
			void operation.then(
				(value) => finish({ kind: "completed", value }),
				(error: unknown) => finish({ kind: "failed", error }),
			);
		});
	}

	private resetTransportState(): void {
		this.parser = new ContentLengthFrameParser(MAX_FRAME_BYTES);
		this.writerTail = Promise.resolve();
		this.acceptTail = Promise.resolve();
	}

	private scheduleRestart(): void {
		if (
			this.shutdownRequested ||
			this.stopping ||
			this.restartTimer ||
			this.child
		)
			return;
		const delay =
			RESTART_DELAYS_MS[
				Math.min(this.restartAttempt, RESTART_DELAYS_MS.length - 1)
			] ?? RESTART_DELAYS_MS[RESTART_DELAYS_MS.length - 1];
		if (delay === undefined) return;
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

function positiveShutdownTimeout(
	configured: number | undefined,
	fallback: number,
): number {
	const value = configured ?? fallback;
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new MastraSidecarError(
			"INVALID_SHUTDOWN_TIMEOUT",
			"本地 Agent Sidecar 关闭预算无效。",
			false,
		);
	}
	return value;
}

function cancelledRequestError(): MastraSidecarError {
	return new MastraSidecarError(
		"CANCELLED",
		"本地 Agent Sidecar 请求已取消。",
		true,
	);
}

function sidecarShutdownError(): MastraSidecarError {
	return new MastraSidecarError(
		"SHUTDOWN_REQUESTED",
		"本地 Agent Sidecar 已进入永久关闭状态。",
		false,
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
