import type { AuthService, SessionExpiredListener } from "../../features/auth/auth-service";
import { AuthServiceError } from "../../features/auth/auth-service";
import type { AuthCredentials, AuthSession } from "../../features/auth/domain";
import type { AuthRpcResult } from "../../../../shared/auth";

export class ElectrobunAuthService implements AuthService {
	private readonly expiryListeners = new Set<SessionExpiredListener>();
	private unsubscribe: (() => void) | null = null;

	async restoreSession(): Promise<AuthSession | null> {
		const { clientApi } = await import("../../rpc");
		this.ensureExpirySubscription(clientApi);
		return unwrap(await clientApi.restoreAuthSession());
	}

	async signIn(credentials: AuthCredentials): Promise<AuthSession> {
		const { clientApi } = await import("../../rpc");
		this.ensureExpirySubscription(clientApi);
		return unwrap(await clientApi.signIn(credentials));
	}

	async signOut(): Promise<void> {
		const { clientApi } = await import("../../rpc");
		unwrap(await clientApi.signOut());
	}

	onSessionExpired(listener: SessionExpiredListener): () => void {
		this.expiryListeners.add(listener);
		return () => this.expiryListeners.delete(listener);
	}

	private ensureExpirySubscription(clientApi: {
		onAuthSessionExpired(listener: () => void): () => void;
	}): void {
		if (this.unsubscribe) return;
		this.unsubscribe = clientApi.onAuthSessionExpired(() => {
			for (const listener of this.expiryListeners) listener();
		});
	}
}

function unwrap<T>(result: AuthRpcResult<T>): T {
	if (result.kind === "success") return result.data;
	throw new AuthServiceError(result.failure);
}
