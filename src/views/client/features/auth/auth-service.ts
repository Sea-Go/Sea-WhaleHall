import {
	type AuthCredentials,
	type AuthFailure,
	type AuthFailureKind,
	type AuthSession,
	createAuthFailure,
} from "./domain";

export type SessionExpiredListener = () => void;

export interface AuthService {
	restoreSession(): Promise<AuthSession | null>;
	signIn(credentials: AuthCredentials): Promise<AuthSession>;
	signOut(): Promise<void>;
	onSessionExpired(listener: SessionExpiredListener): () => void;
}

export class AuthServiceError extends Error {
	readonly kind: AuthFailureKind;

	constructor(kind: AuthFailureKind) {
		super(`Authentication service failure: ${kind}`);
		this.name = "AuthServiceError";
		this.kind = kind;
	}
}

export function authFailureFromUnknown(reason: unknown): AuthFailure {
	if (reason instanceof AuthServiceError) {
		return createAuthFailure(reason.kind);
	}
	return createAuthFailure("unexpected");
}
