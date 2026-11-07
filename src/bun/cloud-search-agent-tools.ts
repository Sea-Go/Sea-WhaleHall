import { createHash, randomBytes } from "node:crypto";
import type { AuthSessionIdentity } from "../shared/session-identity";
import type { RTWCloudToolsRun } from "./clients/product/rtw-cloud-tools-client";
import {
	type RTWCloudToolsClient,
	RTWCloudToolsError,
} from "./clients/product/rtw-cloud-tools-client";
import type { RTWProductSessionProvider } from "./clients/product/rtw-product-search-client";

/**
 * 云搜索 Agent 工具的 Bun 宿主：Sidecar 的 CloudSearchToolSession 通过协议
 * 反向调用（cloud/parent.open / cloud/search / cloud/read-evidence）到达这里，
 * 由本模块持有 RTW 凭据并驱动 RTWCloudToolsClient。Sidecar 永远不接触令牌。
 */

/** 与历史 pet 搜索一致的逻辑知识会话身份（按 RTW 用户名派生，非 DC 登录 UUID）。 */
export function cloudToolsLogicalSessionIdFor(username: string): string {
	return `whalehall-pet-${createHash("sha256").update(username).digest("hex").slice(0, 24)}`;
}

export interface CloudSearchAgentToolsOptions {
	baseUrl: string;
	sessions: RTWProductSessionProvider;
	accountSessions: {
		current(): AuthSessionIdentity | null;
		isCurrent(identity: AuthSessionIdentity): boolean;
	};
	/** 当前逻辑知识会话身份；无 RTW 会话时返回 null。 */
	logicalSessionId: () => string | null;
	client: RTWCloudToolsClient;
	fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

/** Sidecar 需要的父操作描述（不含任何凭据）。 */
export interface CloudParentDescriptor {
	runId: string;
	accountId: string;
	operationId: string;
	scopeRef: string;
	snapshotRef: string;
	budgetRef: string;
	allowLowerIntelligence: boolean;
	deadlineAtMs: number;
	budget: {
		searchCalls: number;
		readCalls: number;
		quoteRunes: number;
		maxReadsPerSearch: number;
		maxQuoteRunesPerSearch: number;
	};
}

const MODULE_CACHE_TTL_MS = 10 * 60_000;

export class CloudSearchAgentToolsError extends Error {
	constructor(
		readonly code: string,
		readonly permanent: boolean,
	) {
		super(code);
		this.name = "CloudSearchAgentToolsError";
	}
}

export class CloudSearchAgentToolsService {
	private readonly runs = new Map<string, RTWCloudToolsRun>();
	private readonly fetchImpl: NonNullable<
		CloudSearchAgentToolsOptions["fetch"]
	>;
	private moduleCache: { key: string; moduleId: string; at: number } | null =
		null;

	constructor(private readonly options: CloudSearchAgentToolsOptions) {
		this.fetchImpl = options.fetch ?? fetch;
	}

	/** Sidecar conversation 运行开始时调用：创建 RTW tool-runs 父操作。 */
	async openParent(
		runId: string,
		accountId: string,
	): Promise<CloudParentDescriptor> {
		if (typeof runId !== "string" || runId.length === 0) {
			throw new CloudSearchAgentToolsError("INVALID_INPUT", true);
		}
		this.cancelRun(runId);
		const logicalSessionId = this.options.logicalSessionId();
		if (logicalSessionId === null) {
			throw new CloudSearchAgentToolsError("NOT_AUTHENTICATED", true);
		}
		const moduleId = await this.resolveModuleId(logicalSessionId);
		const run = await this.options.client.startParent({
			logicalSessionId,
			moduleId,
			idempotencyKey: `cloudtools-${runId}-${randomBytes(8).toString("hex")}`,
			runId,
			accountId,
			signal: AbortSignal.timeout(30_000),
		});
		this.runs.set(runId, run);
		const parent = run.parent;
		const { signal: _signal, budget, ...descriptor } = parent;
		return { ...descriptor, budget };
	}

	/** Sidecar Port 桥的 search；绑定父操作并透传限制。 */
	async search(
		runId: string,
		input: {
			requestKey: string;
			depth: "fast" | "detailed";
			query: string;
			intelligence: "low" | "medium" | "high";
			continueSearchId?: string;
			limits: { readCalls: number; quoteRunes: number };
		},
	): Promise<unknown> {
		const run = this.requireRun(runId);
		return run.port.search({
			parent: stripSignalAndBudget(run.parent),
			...input,
			signal: run.parent.signal,
		});
	}

	/** Sidecar Port 桥的 readEvidence；绑定父操作。 */
	async readEvidence(
		runId: string,
		input: { requestKey: string; searchId: string; evidenceId: string },
	): Promise<unknown> {
		const run = this.requireRun(runId);
		return run.port.readEvidence({
			parent: stripSignalAndBudget(run.parent),
			...input,
			signal: run.parent.signal,
		});
	}

	/** 运行终态或取消时清理父操作（中止其网络活动）。 */
	cancelRun(runId: string): void {
		const run = this.runs.get(runId);
		if (!run) return;
		this.runs.delete(runId);
		run.cancel();
	}

	/** 将 RTW 客户端错误投影为协议可携带的稳定错误码。 */
	static errorPayload(error: unknown): {
		code: string;
		message: string;
	} {
		if (error instanceof RTWCloudToolsError) {
			// RETRYABLE_FAILURE 多为生产档位不支持（当前仅快搜 low 档）：
			// 给调用方 Agent 一句可执行的纠正方向。
			const hint =
				error.code === "RETRYABLE_FAILURE"
					? "（生产当前仅支持 search_fast 且 intelligence=low；请改用它重试）"
					: "";
			return {
				code: error.code,
				message: `云搜索产品接口错误：${error.code}${hint}`,
			};
		}
		if (error instanceof CloudSearchAgentToolsError) {
			return { code: error.code, message: `云搜索宿主错误：${error.code}` };
		}
		return { code: "UNAVAILABLE", message: "云搜索宿主未知错误。" };
	}

	private requireRun(runId: string): RTWCloudToolsRun {
		const run = this.runs.get(runId);
		if (!run) {
			throw new CloudSearchAgentToolsError("NOT_FOUND", true);
		}
		return run;
	}

	private async resolveModuleId(logicalSessionId: string): Promise<string> {
		const cached = this.moduleCache;
		if (
			cached &&
			cached.key === logicalSessionId &&
			Date.now() - cached.at < MODULE_CACHE_TTL_MS
		) {
			return cached.moduleId;
		}
		const session = await this.options.sessions.current();
		if (!session)
			throw new CloudSearchAgentToolsError("NOT_AUTHENTICATED", true);
		let response: Response;
		try {
			response = await this.fetchImpl(
				new URL("/v1/knowledge/modules?limit=1", this.options.baseUrl),
				{
					method: "GET",
					headers: {
						authorization: `Bearer ${session.accessToken}`,
						accept: "application/json",
					},
					redirect: "error",
					signal: AbortSignal.timeout(10_000),
				},
			);
		} catch {
			throw new CloudSearchAgentToolsError("UNAVAILABLE", false);
		}
		if (response.status === 401 || response.status === 403) {
			throw new CloudSearchAgentToolsError("NOT_AUTHENTICATED", true);
		}
		if (!response.ok) {
			throw new CloudSearchAgentToolsError("UNAVAILABLE", false);
		}
		const payload = (await response.json().catch(() => null)) as {
			data?: { items?: Array<{ id?: unknown }> };
		} | null;
		const moduleId = payload?.data?.items?.[0]?.id;
		if (
			typeof moduleId !== "string" ||
			!/^[A-Za-z0-9_.-]{1,200}$/.test(moduleId)
		) {
			throw new CloudSearchAgentToolsError("BAD_RESPONSE", true);
		}
		this.moduleCache = { key: logicalSessionId, moduleId, at: Date.now() };
		return moduleId;
	}
}

type ProductSessionProbe = ReturnType<RTWProductSessionProvider["current"]>;

function stripSignalAndBudget(
	parent: RTWCloudToolsRun["parent"],
): Omit<RTWCloudToolsRun["parent"], "signal" | "budget"> {
	const { signal: _signal, budget: _budget, ...rest } = parent;
	return rest;
}
