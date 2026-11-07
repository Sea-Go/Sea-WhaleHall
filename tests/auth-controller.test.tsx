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
});

describe("MockAuthService", () => {});

describe("authentication UI", () => {
	const noSubmit = async (_credentials?: AuthCredentials) => {};
});
