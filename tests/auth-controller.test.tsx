import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
	AuthService,
	SessionExpiredListener,
} from "../src/views/client/features/auth/auth-service";
import { AuthServiceError } from "../src/views/client/features/auth/auth-service";
import { AuthController } from "../src/views/client/features/auth/AuthController";
import { AuthBootScreen, AuthPage } from "../src/views/client/features/auth/AuthPage";
import { AuthGate } from "../src/views/client/features/auth/AuthGate";
import type {
	AuthCredentials,
	AuthSession,
} from "../src/views/client/features/auth/domain";
import {
	MockAuthService,
	MOCK_AUTH_EXPERIENCE,
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

class FakeAuthService implements AuthService {
	restoreCalls = 0;
	signInCalls = 0;
	signOutCalls = 0;
	restoreImplementation: () => Promise<AuthSession | null> = async () => null;
	signInImplementation: (
		credentials: AuthCredentials,
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

		const request = controller.signIn(MOCK_AUTH_EXPERIENCE);
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
			email: "person@example.com",
			password: "incorrect",
		});
		const state = controller.getSnapshot();
		expect(state.status).toBe("error");
		if (state.status !== "error") return;
		expect(state.failure.kind).toBe("invalid-credentials");
		expect(state.failure.message).toBe("邮箱或密码不正确，请检查后重新登录。");
		expect(state.failure.message).not.toContain("Authentication service failure");
	});

	test("exposes retryable offline and service-unavailable states", async () => {
		for (const kind of ["offline", "service-unavailable"] as const) {
			const service = new FakeAuthService();
			service.signInImplementation = async () => {
				throw new AuthServiceError(kind);
			};
			const controller = new AuthController(service);
			await controller.start();
			await controller.signIn({
				email: `${kind}@example.com`,
				password: "password",
			});

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

		const first = controller.signIn(MOCK_AUTH_EXPERIENCE);
		const second = controller.signIn(MOCK_AUTH_EXPERIENCE);
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
	test("accepts only deterministic experience credentials and returns no token", async () => {
		const service = new MockAuthService({
			latencyMs: 0,
			now: () => 1_800_000_000_000,
		});
		const session = await service.signIn(MOCK_AUTH_EXPERIENCE);

		expect(session.user).toEqual(demoSession.user);
		expect(JSON.stringify(session)).not.toContain("token");
		await service.signOut();
	});

	test("offers deterministic offline and unavailable scenarios", async () => {
		for (const [email, kind] of [
			["offline@whalehall.local", "offline"],
			["service@whalehall.local", "service-unavailable"],
		] as const) {
			try {
				await new MockAuthService({ latencyMs: 0 }).signIn({
					email,
					password: "irrelevant",
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
	const noSubmit = async () => {};

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

	test("login form uses visible labels and accessible password control", () => {
		const markup = renderToStaticMarkup(
			<AuthPage
				state={{ status: "unauthenticated", notice: null }}
				experienceCredentials={MOCK_AUTH_EXPERIENCE}
				onSubmit={noSubmit}
				onRetry={noSubmit}
			/>,
		);

		expect(markup).toContain('<label for="auth-email">邮箱</label>');
		expect(markup).toContain('<label for="auth-password">密码</label>');
		expect(markup).toContain('aria-label="显示密码"');
		expect(markup).toContain('type="submit"');
		expect(markup).not.toContain('value="whalehall"');
	});

	test("error, offline, retry, authenticating, and expired states are explicit", () => {
		const offlineMarkup = renderToStaticMarkup(
			<AuthPage
				state={{
					status: "error",
					email: "offline@whalehall.local",
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
