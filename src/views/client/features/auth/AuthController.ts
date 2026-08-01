import type { AuthService } from "./auth-service";
import { authFailureFromUnknown } from "./auth-service";
import type {
	AuthBootOperation,
	AuthCredentials,
	AuthState,
} from "./domain";

type AuthStateListener = () => void;

export class AuthController {
	private state: AuthState = {
		status: "booting",
		operation: "restoring-session",
	};
	private readonly listeners = new Set<AuthStateListener>();
	private lifecycleVersion = 0;
	private operationVersion = 0;
	private started = false;
	private stopSessionExpiryListener: (() => void) | null = null;
	private restorePromise: Promise<void> | null = null;
	private signInPromise: Promise<void> | null = null;
	private signOutPromise: Promise<void> | null = null;

	constructor(private readonly service: AuthService) {}

	readonly getSnapshot = (): AuthState => this.state;

	readonly subscribe = (listener: AuthStateListener): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	start(): Promise<void> {
		if (this.started) {
			return this.restorePromise ?? Promise.resolve();
		}

		this.started = true;
		this.lifecycleVersion += 1;
		this.stopSessionExpiryListener = this.service.onSessionExpired(() => {
			this.handleSessionExpired();
		});
		return this.restore("restoring-session");
	}

	stop(): void {
		if (!this.started) return;
		this.started = false;
		this.lifecycleVersion += 1;
		this.operationVersion += 1;
		this.stopSessionExpiryListener?.();
		this.stopSessionExpiryListener = null;
		this.restorePromise = null;
		this.signInPromise = null;
		this.signOutPromise = null;
	}

	retry(): Promise<void> {
		if (this.signInPromise) return this.signInPromise;
		if (this.signOutPromise) return this.signOutPromise;
		return this.restore("retrying");
	}

	signIn(credentials: AuthCredentials): Promise<void> {
		if (this.signInPromise) return this.signInPromise;
		if (this.state.status === "authenticated") return Promise.resolve();

		const operationVersion = ++this.operationVersion;
		const lifecycleVersion = this.lifecycleVersion;
		const email = credentials.email;
		this.setState({ status: "authenticating", email });

		const request = this.performSignIn(
			credentials,
			email,
			lifecycleVersion,
			operationVersion,
		);
		this.signInPromise = request;
		void request.finally(() => {
			if (this.signInPromise === request) {
				this.signInPromise = null;
			}
		});
		return request;
	}

	signOut(): Promise<void> {
		if (this.signOutPromise) return this.signOutPromise;

		const operationVersion = ++this.operationVersion;
		const lifecycleVersion = this.lifecycleVersion;
		this.setState({ status: "booting", operation: "signing-out" });

		const request = this.performSignOut(lifecycleVersion, operationVersion);
		this.signOutPromise = request;
		void request.finally(() => {
			if (this.signOutPromise === request) {
				this.signOutPromise = null;
			}
		});
		return request;
	}

	private restore(operation: AuthBootOperation): Promise<void> {
		if (this.restorePromise) return this.restorePromise;

		const operationVersion = ++this.operationVersion;
		const lifecycleVersion = this.lifecycleVersion;
		this.setState({ status: "booting", operation });

		const request = this.performRestore(
			lifecycleVersion,
			operationVersion,
		);
		this.restorePromise = request;
		void request.finally(() => {
			if (this.restorePromise === request) {
				this.restorePromise = null;
			}
		});
		return request;
	}

	private async performRestore(
		lifecycleVersion: number,
		operationVersion: number,
	): Promise<void> {
		try {
			const session = await this.service.restoreSession();
			if (!this.isCurrent(lifecycleVersion, operationVersion)) return;
			this.setState(
				session
					? { status: "authenticated", session }
					: { status: "unauthenticated", notice: null },
			);
		} catch (reason) {
			if (!this.isCurrent(lifecycleVersion, operationVersion)) return;
			const failure = authFailureFromUnknown(reason);
			if (failure.kind === "expired") {
				this.setState({ status: "expired", message: failure.message });
				return;
			}
			this.setState({ status: "error", email: "", failure });
		}
	}

	private async performSignIn(
		credentials: AuthCredentials,
		email: string,
		lifecycleVersion: number,
		operationVersion: number,
	): Promise<void> {
		try {
			const session = await this.service.signIn(credentials);
			if (!this.isCurrent(lifecycleVersion, operationVersion)) return;
			this.setState({ status: "authenticated", session });
		} catch (reason) {
			if (!this.isCurrent(lifecycleVersion, operationVersion)) return;
			const failure = authFailureFromUnknown(reason);
			if (failure.kind === "expired") {
				this.setState({ status: "expired", message: failure.message });
				return;
			}
			this.setState({ status: "error", email, failure });
		}
	}

	private async performSignOut(
		lifecycleVersion: number,
		operationVersion: number,
	): Promise<void> {
		let notice = "已安全退出登录。";
		try {
			await this.service.signOut();
		} catch {
			notice =
				"已离开当前工作区，但登录服务暂时未确认会话清理。请在网络恢复后重新登录。";
		}
		if (!this.isCurrent(lifecycleVersion, operationVersion)) return;
		this.setState({ status: "unauthenticated", notice });
	}

	private handleSessionExpired(): void {
		this.operationVersion += 1;
		this.setState({
			status: "expired",
			message: "登录会话已过期。为保护你的数据，请重新登录。",
		});
	}

	private isCurrent(
		lifecycleVersion: number,
		operationVersion: number,
	): boolean {
		return (
			this.started &&
			this.lifecycleVersion === lifecycleVersion &&
			this.operationVersion === operationVersion
		);
	}

	private setState(state: AuthState): void {
		this.state = state;
		for (const listener of this.listeners) {
			listener();
		}
	}
}
