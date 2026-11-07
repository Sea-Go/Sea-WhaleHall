import { describe, expect, test } from "bun:test";
import { RTW_SESSION_CREDENTIAL } from "../src/bun/credential-helper-client";
import {
	bindRtwCredentialStore,
	restoreRtwSession,
	rtwProductSessionProvider,
	rtwSessionSignOut,
	rtwSessionUsername,
} from "../src/bun/rtw-session";

class MemoryCredentialStore {
	readonly entries = new Map<string, string>();
	async read(name: string): Promise<string | null> {
		return this.entries.get(name) ?? null;
	}
	async write(name: string, value: string): Promise<void> {
		this.entries.set(name, value);
	}
	async delete(name: string): Promise<void> {
		this.entries.delete(name);
	}
}

describe("rtw session persistence", () => {
	test("sign-out clears stored credentials; restore returns false on empty store", async () => {
		const store = new MemoryCredentialStore();
		bindRtwCredentialStore(store);
		rtwSessionSignOut();
		expect(await restoreRtwSession()).toBeFalse();
		expect(rtwSessionUsername()).toBeNull();
		expect(await store.read(RTW_SESSION_CREDENTIAL)).toBeNull();
	});

	test("restore rehydrates a stored session and provider serves it", async () => {
		const store = new MemoryCredentialStore();
		await store.write(
			RTW_SESSION_CREDENTIAL,
			JSON.stringify({ username: "tester", token: "t".repeat(32) }),
		);
		bindRtwCredentialStore(store);
		expect(await restoreRtwSession()).toBeTrue();
		expect(rtwSessionUsername()).toBe("tester");
		const session = await rtwProductSessionProvider.current();
		expect(session?.accessToken).toBe("t".repeat(32));
		expect(
			session !== null && rtwProductSessionProvider.isCurrent(session),
		).toBeTrue();
		// 二次恢复幂等：已有会话时不再变更。
		expect(await restoreRtwSession()).toBeTrue();
		rtwSessionSignOut();
		expect(await store.read(RTW_SESSION_CREDENTIAL)).toBeNull();
	});
});
