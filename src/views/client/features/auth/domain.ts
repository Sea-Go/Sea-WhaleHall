export interface AuthCredentials {
	email: string;
	password: string;
}

export type AuthExperienceCredentials = AuthCredentials;

export interface AuthUser {
	id: string;
	displayName: string;
	email: string;
	initials: string;
}

export interface AuthSession {
	id: string;
	user: AuthUser;
	expiresAtMs: number;
}

export type AuthFailureKind =
	| "invalid-credentials"
	| "offline"
	| "service-unavailable"
	| "expired"
	| "unexpected";

export interface AuthFailure {
	kind: AuthFailureKind;
	message: string;
	retryable: boolean;
}

export type AuthBootOperation =
	| "restoring-session"
	| "retrying"
	| "signing-out";

export type AuthState =
	| { status: "booting"; operation: AuthBootOperation }
	| { status: "unauthenticated"; notice: string | null }
	| { status: "authenticating"; email: string }
	| { status: "authenticated"; session: AuthSession }
	| { status: "error"; email: string; failure: AuthFailure }
	| { status: "expired"; message: string };

const authFailureCopy: Record<
	AuthFailureKind,
	{ message: string; retryable: boolean }
> = {
	"invalid-credentials": {
		message: "邮箱或密码不正确，请检查后重新登录。",
		retryable: false,
	},
	offline: {
		message: "当前设备似乎已离线。请检查网络连接后重试。",
		retryable: true,
	},
	"service-unavailable": {
		message: "登录服务暂时不可用。你的凭据没有被保存，请稍后重试。",
		retryable: true,
	},
	expired: {
		message: "登录会话已过期。为保护你的数据，请重新登录。",
		retryable: false,
	},
	unexpected: {
		message: "暂时无法完成登录。请稍后重试。",
		retryable: true,
	},
};

export function createAuthFailure(kind: AuthFailureKind): AuthFailure {
	return {
		kind,
		...authFailureCopy[kind],
	};
}

export function normalizeAuthEmail(email: string): string {
	return email.trim().toLowerCase();
}
