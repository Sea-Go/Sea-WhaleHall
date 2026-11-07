import { createHash } from "node:crypto";
import { RTW_SESSION_CREDENTIAL } from "./credential-helper-client";
import type {
	RTWProductSession,
	RTWProductSessionProvider,
} from "./clients/product/rtw-product-search-client";

/** RTW 公网入口；Bun 侧所有 RTW 产品调用共用这一来源。 */
export const RTW_WEB_BASE_URL =
	"https://web-cf.sea-ridethewindbreakthewaves.xyz";

export interface RtwSecureCredentialStore {
	read(name: string): Promise<string | null>;
	write(name: string, value: string): Promise<void>;
	delete(name: string): Promise<void>;
}

export type RtwSessionState = { username: string } | null;

export type RtwSessionLoginResult =
	| { kind: "ok" }
	| { kind: "business"; code: number; message: string }
	| { kind: "network" };

type RtwSessionListener = (state: RtwSessionState) => void;

interface RtwSessionRecord {
	username: string;
	accessToken: string;
	sessionId: string;
	generation: number;
}

interface RtwStoredSession {
	username: string;
	token: string;
}

let current: RtwSessionRecord | null = null;
let credentials: RtwSecureCredentialStore | null = null;
const listeners = new Set<RtwSessionListener>();

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/** 不把用户名原样放进知识会话 URL，用摘要做稳定的逻辑会话身份。 */
function sessionIdForUsername(username: string): string {
	return `rtw-${sha256(username).slice(0, 16)}`;
}

function publish(): void {
	const state: RtwSessionState = current
		? { username: current.username }
		: null;
	for (const listener of listeners) listener(state);
}

function persist(): void {
	if (!credentials || !current) return;
	const stored: RtwStoredSession = {
		username: current.username,
		token: current.accessToken,
	};
	void credentials
		.write(RTW_SESSION_CREDENTIAL, JSON.stringify(stored))
		.catch(() => undefined);
}

function forget(): void {
	if (!credentials) return;
	void credentials.delete(RTW_SESSION_CREDENTIAL).catch(() => undefined);
}

/**
 * 绑定安全凭据库后，RTW 会话与 DC 登录同构：登录一次，重启自动恢复。
 * RTW token 有效期约 30 天；失效时首个 401 会清除存储并回到登录表单。
 */
export function bindRtwCredentialStore(store: RtwSecureCredentialStore): void {
	credentials = store;
}

export function subscribeRtwSession(listener: RtwSessionListener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function rtwSessionUsername(): string | null {
	return current?.username ?? null;
}

export function rtwSessionAccessToken(): string | null {
	return current?.accessToken ?? null;
}

/** 启动时从安全凭据库恢复上次登录的 RTW 会话；无存储或损坏时静默返回 false。 */
export async function restoreRtwSession(): Promise<boolean> {
	if (current || !credentials) return current !== null;
	let stored: RtwStoredSession | null = null;
	try {
		const raw = await credentials.read(RTW_SESSION_CREDENTIAL);
		if (raw !== null) {
			const parsed = JSON.parse(raw) as Partial<RtwStoredSession>;
			if (
				typeof parsed.username === "string" &&
				parsed.username.length > 0 &&
				parsed.username.length <= 128 &&
				typeof parsed.token === "string" &&
				parsed.token.length >= 20
			) {
				stored = { username: parsed.username, token: parsed.token };
			}
		}
	} catch {
		stored = null;
	}
	if (!stored) return false;
	current = {
		username: stored.username,
		accessToken: stored.token,
		sessionId: sessionIdForUsername(stored.username),
		generation: 1,
	};
	publish();
	return true;
}

export function rtwSessionLogin(input: {
	username: string;
	password: string;
}): Promise<RtwSessionLoginResult> {
	const username = input.username.trim();
	if (
		username.length === 0 ||
		username.length > 128 ||
		input.password.length === 0 ||
		input.password.length > 256
	) {
		return Promise.resolve({
			kind: "business",
			code: 0,
			message: "登录信息无效",
		});
	}
	return (async () => {
		let response: Response;
		try {
			response = await fetch(
				`${RTW_WEB_BASE_URL}/api/usercenter/v1/user/login`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ username, password: input.password }),
					signal: AbortSignal.timeout(15_000),
					redirect: "error",
				},
			);
		} catch {
			return { kind: "network" } as const;
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			return { kind: "network" } as const;
		}
		const envelope = payload as {
			code?: unknown;
			msg?: unknown;
			data?: unknown;
		};
		const token =
			envelope?.data !== null &&
			typeof envelope?.data === "object" &&
			typeof (envelope.data as { token?: unknown }).token === "string"
				? (envelope.data as { token: string }).token
				: null;
		if (
			response.status !== 200 ||
			envelope?.code !== 200 ||
			!token ||
			token.length < 20
		) {
			return {
				kind: "business",
				code:
					typeof envelope?.code === "number" ? envelope.code : response.status,
				message:
					typeof envelope?.msg === "string" && envelope.msg
						? envelope.msg
						: "登录失败",
			};
		}
		current = {
			username,
			accessToken: token,
			sessionId: sessionIdForUsername(username),
			generation: (current?.generation ?? 0) + 1,
		};
		persist();
		publish();
		return { kind: "ok" } as const;
	})();
}

export function rtwSessionSignOut(): void {
	forget();
	if (!current) return;
	current = null;
	publish();
}

/** 供 WhaleHall 各产品传输层使用的会话提供者；凭据只归 Bun 持有。 */
export const rtwProductSessionProvider: RTWProductSessionProvider = {
	async current(): Promise<RTWProductSession | null> {
		if (!current) return null;
		return {
			accessToken: current.accessToken,
			sessionId: current.sessionId,
			generation: current.generation,
		};
	},
	isCurrent(session: RTWProductSession): boolean {
		return (
			current !== null &&
			current.accessToken === session.accessToken &&
			current.sessionId === session.sessionId &&
			current.generation === session.generation
		);
	},
};
