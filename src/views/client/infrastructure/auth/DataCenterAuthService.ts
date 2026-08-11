import type {
	AuthService,
	SessionExpiredListener,
} from "../../features/auth/auth-service";
import { AuthServiceError } from "../../features/auth/auth-service";
import type {
	AuthCredentials,
	AuthSession,
} from "../../features/auth/domain";
import type { DataCenterAuthSessionProjection } from "../../../../shared/contracts";

export interface DataCenterAuthTransport {
	datacenterSignIn(credentials: {
		email: string;
		password: string;
	}): Promise<{ session: DataCenterAuthSessionProjection }>;
	datacenterSignOut(): Promise<{ signedOut: boolean }>;
	datacenterRestoreSession(): Promise<{
		session: DataCenterAuthSessionProjection | null;
	}>;
}

export interface DataCenterAuthServiceOptions {
	loadTransport?: () => Promise<DataCenterAuthTransport>;
}

/**
 * Production AuthService backed by the Sea DataCenter native session API.
 * All HTTP and token storage live in the Electrobun main process; this
 * WebView service only marshals credentials and session projections over the
 * typed RPC bridge. The transport is loaded lazily so importing the app in
 * SSR never pulls the Electrobun renderer runtime.
 */
export class DataCenterAuthService implements AuthService {
	private readonly loadTransport: () => Promise<DataCenterAuthTransport>;

	constructor(options: DataCenterAuthServiceOptions = {}) {
		this.loadTransport = options.loadTransport ?? loadClientTransport;
	}

	async restoreSession(): Promise<AuthSession | null> {
		const transport = await this.loadTransport();
		try {
			const { session } = await transport.datacenterRestoreSession();
			return session === null ? null : toAuthSession(session);
		} catch (reason) {
			throw toAuthServiceError(reason);
		}
	}

	async signIn(credentials: AuthCredentials): Promise<AuthSession> {
		const transport = await this.loadTransport();
		try {
			const { session } = await transport.datacenterSignIn({
				email: credentials.email,
				password: credentials.password,
			});
			return toAuthSession(session);
		} catch (reason) {
			throw toAuthServiceError(reason);
		}
	}

	async signOut(): Promise<void> {
		const transport = await this.loadTransport();
		try {
			await transport.datacenterSignOut();
		} catch {
			// Local sign-out still clears the stored session.
		}
	}

	onSessionExpired(listener: SessionExpiredListener): () => void {
		// The main process refreshes the native session internally. Hard
		// expiry is surfaced through restore/signIn error kinds.
		void listener;
		return () => {};
	}
}

function toAuthSession(
	session: DataCenterAuthSessionProjection,
): AuthSession {
	return {
		id: session.id,
		user: { ...session.user },
		expiresAtMs: session.expiresAtMs,
	};
}

function toAuthServiceError(reason: unknown): AuthServiceError {
	const kind = parseAuthKind(reason);
	switch (kind) {
		case "invalid_credentials":
			return new AuthServiceError("invalid-credentials");
		case "offline":
			return new AuthServiceError("offline");
		case "service_unavailable":
			return new AuthServiceError("service-unavailable");
		case "expired":
			return new AuthServiceError("expired");
		default:
			return new AuthServiceError("unexpected");
	}
}

function parseAuthKind(reason: unknown): string | null {
	const message =
		typeof reason === "object" &&
		reason !== null &&
		"message" in reason &&
		typeof reason.message === "string"
			? reason.message
			: String(reason ?? "");
	const match = /^DATACENTER_AUTH:([A-Za-z_]+)/u.exec(message);
	return match?.[1] ?? null;
}

async function loadClientTransport(): Promise<DataCenterAuthTransport> {
	const { clientApi } = await import("../../rpc");
	return {
		datacenterSignIn: (credentials) => clientApi.datacenterSignIn(credentials),
		datacenterSignOut: () => clientApi.datacenterSignOut(),
		datacenterRestoreSession: () => clientApi.datacenterRestoreSession(),
	};
}
