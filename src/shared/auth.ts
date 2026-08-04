/**
 * Public authentication projection. Long-lived tokens never cross the Bun
 * boundary. Test-only LocalTestAuth fixtures live separately and are never
 * rendered by the production desktop login screen.
 */
export interface AuthCredentials {
	email: string;
	password: string;
}

export const LOCAL_TEST_AUTH_EXPERIENCE = {
	email: "demo@whalehall.local",
	password: "whalehall",
} as const satisfies AuthCredentials;

export const LOCAL_TEST_AUTH_USER = {
	id: "user-demo-wang-yiming",
	displayName: "王一鸣",
	email: LOCAL_TEST_AUTH_EXPERIENCE.email,
	initials: "鸣",
} as const;

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

export type AuthRpcFailureKind =
	| "invalid-credentials"
	| "offline"
	| "service-unavailable"
	| "expired"
	| "unexpected";

export type AuthRpcResult<T> =
	| { kind: "success"; data: T }
	| { kind: "error"; failure: AuthRpcFailureKind; message: string };
