import { DataCenterHttpClient, DataCenterHttpError } from "./http";
import type { DataCenterNativeSession } from "./types";

export type DataCenterAuthFailureKind =
	| "invalid_credentials"
	| "offline"
	| "service_unavailable"
	| "expired"
	| "unexpected";

export class DataCenterAuthError extends Error {
	readonly kind: DataCenterAuthFailureKind;

	constructor(kind: DataCenterAuthFailureKind, message: string) {
		super(message);
		this.name = "DataCenterAuthError";
		this.kind = kind;
	}
}

export class DataCenterAuthClient {
	constructor(private readonly http: DataCenterHttpClient) {}

	async signIn(
		email: string,
		password: string,
	): Promise<DataCenterNativeSession> {
		try {
			return await this.http.post<DataCenterNativeSession>(
				"/v1/auth/sessions",
				{ email, password },
			);
		} catch (error) {
			throw mapSignInError(error);
		}
	}

	async refresh(
		refreshToken: string,
	): Promise<DataCenterNativeSession> {
		try {
			return await this.http.post<DataCenterNativeSession>(
				"/v1/auth/sessions/refresh",
				{ refreshToken },
			);
		} catch (error) {
			throw mapRefreshError(error);
		}
	}

	async signOut(accessToken: string): Promise<void> {
		try {
			await this.http.delete("/v1/auth/sessions/current", {
				bearer: accessToken,
			});
		} catch {
			// Local sign-out still succeeds when the remote session is gone.
		}
	}
}

function mapSignInError(error: unknown): DataCenterAuthError {
	if (error instanceof DataCenterHttpError) {
		if (error.kind === "offline" || error.kind === "timeout") {
			return new DataCenterAuthError("offline", "无法连接 DataCenter。");
		}
		if (error.status === 401) {
			return new DataCenterAuthError(
				"invalid_credentials",
				"邮箱或密码不正确。",
			);
		}
		if (error.status !== null && error.status >= 500) {
			return new DataCenterAuthError(
				"service_unavailable",
				"DataCenter 暂时不可用。",
			);
		}
	}
	return new DataCenterAuthError("unexpected", "登录失败。");
}

function mapRefreshError(error: unknown): DataCenterAuthError {
	if (error instanceof DataCenterHttpError) {
		if (error.kind === "offline" || error.kind === "timeout") {
			return new DataCenterAuthError("offline", "无法连接 DataCenter。");
		}
		if (error.status === 401) {
			return new DataCenterAuthError("expired", "会话已过期。");
		}
		if (error.status !== null && error.status >= 500) {
			return new DataCenterAuthError(
				"service_unavailable",
				"DataCenter 暂时不可用。",
			);
		}
	}
	return new DataCenterAuthError("unexpected", "刷新会话失败。");
}
