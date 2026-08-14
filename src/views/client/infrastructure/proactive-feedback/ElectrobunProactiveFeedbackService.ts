import {
	isClearProactiveFeedbackResult,
	isProactiveFeedbackAvailable,
	isProactiveFeedbackPage,
	isProactiveFeedbackPolicySnapshot,
	type ProactiveFeedbackAvailable,
	type ProactiveFeedbackHistoryCursor,
	type ProactiveFeedbackPage,
	type ProactiveFeedbackPolicy,
	type ProactiveFeedbackPolicySnapshot,
	type SetProactiveFeedbackPolicyRequest,
} from "../../../../shared/proactive-feedback";
import {
	type ProactiveFeedbackService,
	ProactiveFeedbackServiceError,
	type ProactiveFeedbackServiceFailure,
} from "../../features/proactive-feedback/proactive-feedback-service";

export interface ProactiveFeedbackRpcClient {
	getProactiveFeedbackPolicy(): Promise<unknown>;
	setProactiveFeedbackPolicy(
		request: SetProactiveFeedbackPolicyRequest,
	): Promise<unknown>;
	listProactiveFeedback(request: {
		cursor?: ProactiveFeedbackHistoryCursor;
		limit: number;
	}): Promise<unknown>;
	clearProactiveFeedbackData(): Promise<unknown>;
	onProactiveFeedbackAvailable(
		listener: (event: ProactiveFeedbackAvailable) => void,
	): () => void;
}

export class ElectrobunProactiveFeedbackService
	implements ProactiveFeedbackService
{
	private readonly listeners = new Set<
		(event: ProactiveFeedbackAvailable) => void
	>();
	private removeClientListener: (() => void) | null = null;
	private subscriptionAttempt: Promise<void> | null = null;

	constructor(private readonly injectedClient?: ProactiveFeedbackRpcClient) {}

	async loadPolicy(): Promise<ProactiveFeedbackPolicySnapshot> {
		const value = this.injectedClient
			? await this.injectedClient.getProactiveFeedbackPolicy()
			: await invokeClientApi("getProactiveFeedbackPolicy");
		return unwrap(value, isProactiveFeedbackPolicySnapshot);
	}

	async setPolicy(
		policy: ProactiveFeedbackPolicy,
		expectedRevision: number,
	): Promise<ProactiveFeedbackPolicySnapshot> {
		const request = { policy: { ...policy }, expectedRevision };
		const value = this.injectedClient
			? await this.injectedClient.setProactiveFeedbackPolicy(request)
			: await invokeClientApi("setProactiveFeedbackPolicy", request);
		return unwrap(value, isProactiveFeedbackPolicySnapshot);
	}

	async listHistory(input: {
		cursor?: ProactiveFeedbackHistoryCursor;
		limit: number;
	}): Promise<ProactiveFeedbackPage> {
		const request = input.cursor
			? { cursor: { ...input.cursor }, limit: input.limit }
			: { limit: input.limit };
		const value = this.injectedClient
			? await this.injectedClient.listProactiveFeedback(request)
			: await invokeClientApi("listProactiveFeedback", request);
		const page = unwrap(value, isProactiveFeedbackPage);
		return {
			items: page.items.map((item) => ({ ...item })),
			nextCursor: page.nextCursor ? { ...page.nextCursor } : null,
		};
	}

	async clear(): Promise<{ clearedAtMs: number }> {
		const value = this.injectedClient
			? await this.injectedClient.clearProactiveFeedbackData()
			: await invokeClientApi("clearProactiveFeedbackData");
		return unwrap(value, isClearProactiveFeedbackResult);
	}

	onAvailable(
		listener: (event: ProactiveFeedbackAvailable) => void,
	): () => void {
		this.listeners.add(listener);
		void this.ensureSubscription();
		return () => {
			this.listeners.delete(listener);
			if (this.listeners.size !== 0) return;
			this.removeClientListener?.();
			this.removeClientListener = null;
		};
	}

	private async ensureSubscription(): Promise<void> {
		if (this.removeClientListener || this.subscriptionAttempt) return;
		this.subscriptionAttempt = (async () => {
			try {
				const subscribe = this.injectedClient
					? (listener: (event: ProactiveFeedbackAvailable) => void) =>
							this.injectedClient?.onProactiveFeedbackAvailable(listener) ??
							(() => {})
					: await loadClientSubscription();
				if (this.listeners.size === 0 || this.removeClientListener) return;
				this.removeClientListener = subscribe((event) => {
					if (!isProactiveFeedbackAvailable(event)) return;
					for (const current of this.listeners) current({ ...event });
				});
			} catch {
				// Request surfaces expose bridge availability through explicit UI states.
			} finally {
				this.subscriptionAttempt = null;
			}
		})();
		await this.subscriptionAttempt;
	}
}

type ProactiveFeedbackRequestMethod =
	| "getProactiveFeedbackPolicy"
	| "setProactiveFeedbackPolicy"
	| "listProactiveFeedback"
	| "clearProactiveFeedbackData";

async function invokeClientApi(
	methodName: ProactiveFeedbackRequestMethod,
	request?: unknown,
): Promise<unknown> {
	const clientApi = await loadClientApi();
	const method = clientApi[methodName];
	if (typeof method !== "function") throw unavailable();
	const invocation: unknown = Reflect.apply(
		method,
		clientApi,
		request === undefined ? [] : [request],
	);
	return Promise.resolve(invocation);
}

async function loadClientSubscription(): Promise<
	(listener: (event: ProactiveFeedbackAvailable) => void) => () => void
> {
	const clientApi = await loadClientApi();
	const method = clientApi.onProactiveFeedbackAvailable;
	if (typeof method !== "function") throw unavailable();
	return (listener) => {
		const result: unknown = Reflect.apply(method, clientApi, [listener]);
		if (typeof result !== "function") return () => {};
		return () => {
			Reflect.apply(result, undefined, []);
		};
	};
}

async function loadClientApi(): Promise<Record<string, unknown>> {
	if (!hasElectrobunRuntime()) throw unavailable();
	const imported: unknown = await import("../../rpc");
	if (!isRecord(imported) || !isRecord(imported.clientApi)) throw unavailable();
	return imported.clientApi;
}

function unwrap<T>(value: unknown, validate: (data: unknown) => data is T): T {
	if (!isRecord(value) || typeof value.kind !== "string")
		throw invalidResponse();
	if (value.kind === "success") {
		if (!validate(value.data)) throw invalidResponse();
		return value.data;
	}
	if (value.kind !== "error" || !isFailure(value.failure))
		throw invalidResponse();
	const message = typeof value.message === "string" ? value.message : "";
	const currentRevision =
		typeof value.currentRevision === "number" &&
		Number.isSafeInteger(value.currentRevision) &&
		value.currentRevision >= 0
			? value.currentRevision
			: undefined;
	throw new ProactiveFeedbackServiceError(
		value.failure,
		message,
		currentRevision,
	);
}

function isFailure(value: unknown): value is ProactiveFeedbackServiceFailure {
	return (
		value === "signed-out" ||
		value === "offline" ||
		value === "service-unavailable" ||
		value === "version-conflict" ||
		value === "invalid-request" ||
		value === "unexpected"
	);
}

function invalidResponse(): ProactiveFeedbackServiceError {
	return new ProactiveFeedbackServiceError(
		"invalid-response",
		"Proactive feedback RPC returned an invalid response.",
	);
}

function unavailable(): ProactiveFeedbackServiceError {
	return new ProactiveFeedbackServiceError(
		"service-unavailable",
		"Proactive feedback RPC is unavailable.",
	);
}

function hasElectrobunRuntime(): boolean {
	return (
		typeof window !== "undefined" &&
		"__electrobun" in window &&
		"__electrobunBunBridge" in window
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
