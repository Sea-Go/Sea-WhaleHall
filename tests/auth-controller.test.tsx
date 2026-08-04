import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthController } from "../src/views/client/features/auth/AuthController";
import { AuthGate } from "../src/views/client/features/auth/AuthGate";
import {
	AuthBootScreen,
	AuthPage,
} from "../src/views/client/features/auth/AuthPage";
import type {
	AuthService,
	SessionExpiredListener,
} from "../src/views/client/features/auth/auth-service";
import { AuthServiceError } from "../src/views/client/features/auth/auth-service";
import type {
	AuthCredentials,
	AuthSession,
} from "../src/views/client/features/auth/domain";
import {
	MOCK_AUTH_EXPERIENCE,
	MOCK_AUTH_SCENARIOS,
	MockAuthService,
} from "../src/views/client/infrastructure/auth/MockAuthService";

const demoSession: AuthSession = {
	id: "session-test",
	expiresAtMs: 1_900_000_000_000,
	user: {
		id: "user-demo-wang-yiming",
		displayName: "王一鸣",
		email: "demo@whalehall.local",
		initials: "鸣",
	},
};

const demoCredentials: AuthCredentials = { ...MOCK_AUTH_EXPERIENCE };

class FakeAuthService implements AuthService {
	restoreCalls = 0;
	signInCalls = 0;
	signOutCalls = 0;
	restoreImplementation: () => Promise<AuthSession | null> = async () => null;
	signInImplementation: (
		_credentials: AuthCredentials,
	) => Promise<AuthSession> = async () => demoSession;
	signOutImplementation: () => Promise<void> = async () => {};
	private readonly expiryListeners = new Set<SessionExpiredListener>();

	restoreSession(): Promise<AuthSession | null> {
		this.restoreCalls += 1;
		return this.restoreImplementation();
	}

	signIn(credentials: AuthCredentials): Promise<AuthSession> {
		this.signInCalls += 1;
		return this.signInImplementation(credentials);
	}

	signOut(): Promise<void> {
		this.signOutCalls += 1;
		return this.signOutImplementation();
	}

	onSessionExpired(listener: SessionExpiredListener): () => void {
		this.expiryListeners.add(listener);
		return () => this.expiryListeners.delete(listener);
	}

	expireSession(): void {
		for (const listener of this.expiryListeners) {
			listener();
		}
	}
}

function controlledPromise<T>() {
	let resolvePromise: (value: T) => void = () => {};
	let rejectPromise: (reason: unknown) => void = () => {};
	const promise = new Promise<T>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	return {
		promise,
		resolve: resolvePromise,
		reject: rejectPromise,
	};
}

describe("AuthController", () => {
	test("stays booting until session restore resolves, then becomes unauthenticated", async () => {
		const service = new FakeAuthService();
		const restore = controlledPromise<AuthSession | null>();
		service.restoreImplementation = () => restore.promise;
		const controller = new AuthController(service);

		const boot = controller.start();
		expect(controller.getSnapshot()).toEqual({
			status: "booting",
			operation: "restoring-session",
		});

		restore.resolve(null);
		await boot;
		expect(controller.getSnapshot()).toEqual({
			status: "unauthenticated",
			notice: null,
		});
	});

	test("moves through authenticating to authenticated", async () => {
		const service = new FakeAuthService();
		const signIn = controlledPromise<AuthSession>();
		service.signInImplementation = () => signIn.promise;
		const controller = new AuthController(service);
		await controller.start();

		const request = controller.signIn(demoCredentials);
		expect(controller.getSnapshot()).toEqual({
			status: "authenticating",
			email: MOCK_AUTH_EXPERIENCE.email,
		});

		signIn.resolve(demoSession);
		await request;
		expect(controller.getSnapshot()).toEqual({
			status: "authenticated",
			session: demoSession,
		});
	});

	test("maps invalid credentials to safe product copy", async () => {
		const service = new FakeAuthService();
		service.signInImplementation = async () => {
			throw new AuthServiceError("invalid-credentials");
		};
		const controller = new AuthController(service);
		await controller.start();

		await controller.signIn({
			email: MOCK_AUTH_EXPERIENCE.email,
			password: "wrong-password",
		});
		const state = controller.getSnapshot();
		expect(state.status).toBe("error");
		if (state.status !== "error") return;
		expect(state.failure.kind).toBe("invalid-credentials");
		expect(state.failure.message).toContain("邮箱或密码不正确");
		expect(state.email).toBe(MOCK_AUTH_EXPERIENCE.email);
		expect(state.failure.message).not.toContain(
			"Authentication service failure",
		);
	});

	test("exposes retryable offline and service-unavailable states", async () => {
		for (const kind of ["offline", "service-unavailable"] as const) {
			const service = new FakeAuthService();
			service.signInImplementation = async () => {
				throw new AuthServiceError(kind);
			};
			const controller = new AuthController(service);
			await controller.start();
			await controller.signIn(demoCredentials);

			const state = controller.getSnapshot();
			expect(state.status).toBe("error");
			if (state.status !== "error") continue;
			expect(state.failure.kind).toBe(kind);
			expect(state.failure.retryable).toBe(true);
		}
	});

	test("deduplicates rapid repeated sign-in attempts", async () => {
		const service = new FakeAuthService();
		const signIn = controlledPromise<AuthSession>();
		service.signInImplementation = () => signIn.promise;
		const controller = new AuthController(service);
		await controller.start();

		const first = controller.signIn(demoCredentials);
		const second = controller.signIn(demoCredentials);
		expect(first).toBe(second);
		expect(service.signInCalls).toBe(1);

		signIn.resolve(demoSession);
		await Promise.all([first, second]);
		expect(controller.getSnapshot().status).toBe("authenticated");
	});

	test("removes protected state immediately when the session expires", async () => {
		const service = new FakeAuthService();
		service.restoreImplementation = async () => demoSession;
		const controller = new AuthController(service);
		await controller.start();
		expect(controller.getSnapshot().status).toBe("authenticated");

		service.expireSession();
		const state = controller.getSnapshot();
		expect(state.status).toBe("expired");
		if (state.status !== "expired") return;
		expect(state.message).toContain("重新登录");
	});

	test("logout hides the authenticated shell and returns to login", async () => {
		const service = new FakeAuthService();
		service.restoreImplementation = async () => demoSession;
		const signOut = controlledPromise<void>();
		service.signOutImplementation = () => signOut.promise;
		const controller = new AuthController(service);
		await controller.start();

		const request = controller.signOut();
		expect(controller.getSnapshot()).toEqual({
			status: "booting",
			operation: "signing-out",
		});
		expect(service.signOutCalls).toBe(1);

		signOut.resolve();
		await request;
		expect(controller.getSnapshot()).toEqual({
			status: "unauthenticated",
			notice: "已安全退出登录。",
		});
	});

	test("logout failure still removes protected content without leaking the service error", async () => {
		const service = new FakeAuthService();
		service.restoreImplementation = async () => demoSession;
		service.signOutImplementation = async () => {
			throw new Error("transport code and internal endpoint");
		};
		const controller = new AuthController(service);
		await controller.start();

		await controller.signOut();
		const state = controller.getSnapshot();
		expect(state.status).toBe("unauthenticated");
		if (state.status !== "unauthenticated") return;
		expect(state.notice).toContain("未确认会话清理");
		expect(state.notice).not.toContain("transport");
		expect(state.notice).not.toContain("endpoint");
	});

	test("restarts session restore safely after a Strict Mode remount", async () => {
		const service = new FakeAuthService();
		const staleRestore = controlledPromise<AuthSession | null>();
		service.restoreImplementation = () => staleRestore.promise;
		const controller = new AuthController(service);
		const staleBoot = controller.start();
		controller.stop();

		service.restoreImplementation = async () => null;
		await controller.start();
		expect(service.restoreCalls).toBe(2);
		expect(controller.getSnapshot().status).toBe("unauthenticated");

		staleRestore.resolve(demoSession);
		await staleBoot;
		expect(controller.getSnapshot().status).toBe("unauthenticated");
	});
});

describe("MockAuthService", () => {
	test("activates a deterministic test account and returns no token", async () => {
		const service = new MockAuthService({
			latencyMs: 0,
			now: () => 1_800_000_000_000,
		});
		const session = await service.signIn(demoCredentials);

		expect(session.user).toEqual(demoSession.user);
		expect(JSON.stringify(session)).not.toContain("token");
		await service.signOut();
	});

	test("offers deterministic offline and unavailable scenarios", async () => {
		for (const [email, kind] of [
			[MOCK_AUTH_SCENARIOS.offlineEmail, "offline"],
			[MOCK_AUTH_SCENARIOS.serviceUnavailableEmail, "service-unavailable"],
		] as const) {
			try {
				await new MockAuthService({ latencyMs: 0 }).signIn({
					email,
					password: demoCredentials.password,
				});
				throw new Error("Expected mock authentication to fail");
			} catch (reason) {
				expect(reason).toBeInstanceOf(AuthServiceError);
				if (reason instanceof AuthServiceError) {
					expect(reason.kind).toBe(kind);
				}
			}
		}
	});
});

describe("authentication UI", () => {
	const noSubmit = async (_credentials?: AuthCredentials) => {};

	test("AuthGate renders a neutral boot screen before protected content", () => {
		const service = new FakeAuthService();
		const markup = renderToStaticMarkup(
			<AuthGate
				service={service}
				renderAuthenticated={() => <div>受保护的工作空间</div>}
			/>,
		);

		expect(markup).toContain("正在确认登录状态");
		expect(markup).not.toContain("受保护的工作空间");
	});

	test("login page asks for a remote account without exposing a demo credential", () => {
		const markup = renderToStaticMarkup(
			<AuthPage
				state={{ status: "unauthenticated", notice: null }}
				onSubmit={noSubmit}
				onRetry={noSubmit}
			/>,
		);

		expect(markup).toContain("登录");
		expect(markup).toContain('type="submit"');
		expect(markup).toContain('value=""');
		expect(markup).toContain("使用你的 WhaleHall 账号安全登录");
		expect(markup).toContain("不会发送给模型");
		expect(markup).not.toContain("体验密码");
		expect(markup).not.toContain("userId");
	});

	test("error, offline, retry, authenticating, and expired states are explicit", () => {
		const offlineMarkup = renderToStaticMarkup(
			<AuthPage
				state={{
					status: "error",
					email: MOCK_AUTH_EXPERIENCE.email,
					failure: {
						kind: "offline",
						message: "当前设备似乎已离线。请检查网络连接后重试。",
						retryable: true,
					},
				}}
				onSubmit={noSubmit}
				onRetry={noSubmit}
			/>,
		);
		const authenticatingMarkup = renderToStaticMarkup(
			<AuthPage
				state={{
					status: "authenticating",
					email: MOCK_AUTH_EXPERIENCE.email,
				}}
				onSubmit={noSubmit}
				onRetry={noSubmit}
			/>,
		);
		const expiredMarkup = renderToStaticMarkup(
			<AuthPage
				state={{
					status: "expired",
					message: "登录会话已过期。为保护你的数据，请重新登录。",
				}}
				onSubmit={noSubmit}
				onRetry={noSubmit}
			/>,
		);

		expect(offlineMarkup).toContain("设备已离线");
		expect(offlineMarkup).toContain("重试连接");
		expect(authenticatingMarkup).toContain('aria-busy="true"');
		expect(authenticatingMarkup).toContain("正在登录…");
		expect(expiredMarkup).toContain("会话已过期");
	});

	test("boot screen distinguishes signing out from initial restore", () => {
		const markup = renderToStaticMarkup(
			<AuthBootScreen operation="signing-out" />,
		);
		expect(markup).toContain("正在安全退出");
		expect(markup).not.toContain("工作空间");
	});
});
