import type { DataCenterAuthSessionProjection } from "../shared/datacenter";

export const DEVELOPMENT_QA_CREDENTIALS = Object.freeze({
	email: "demo@whalehall.local",
	password: "whalehall",
});

/**
 * QA authentication is a main-process capability, never a renderer query flag.
 * It deliberately fails closed for canary/stable even when the environment is
 * inherited from a developer shell.
 */
export function isDevelopmentQaMode(
	runtimeChannel: string,
	environment: Readonly<Record<string, string | undefined>>,
): boolean {
	return (
		runtimeChannel === "dev" && environment.WHALEHALL_QA_MODE === "1"
	);
}

export function developmentQaWindowSize(
	runtimeChannel: string,
	environment: Readonly<Record<string, string | undefined>>,
): { width: number; height: number } | null {
	if (!isDevelopmentQaMode(runtimeChannel, environment)) return null;
	const requested = `${environment.WHALEHALL_QA_WINDOW_WIDTH ?? ""}x${environment.WHALEHALL_QA_WINDOW_HEIGHT ?? ""}`;
	if (requested === "1440x900") return { width: 1440, height: 900 };
	if (requested === "1180x720") return { width: 1180, height: 720 };
	return null;
}

export class DevelopmentQaAuthSession {
	private session: DataCenterAuthSessionProjection | null = null;

	signIn(
		email: string,
		password: string,
		nowMs = Date.now(),
	): DataCenterAuthSessionProjection | null {
		if (
			email.trim().toLowerCase() !== DEVELOPMENT_QA_CREDENTIALS.email ||
			password !== DEVELOPMENT_QA_CREDENTIALS.password
		) {
			return null;
		}
		this.session = {
			id: "development-qa-session",
			user: {
				id: "development-qa-user",
				displayName: "WhaleHall 体验用户",
				email: DEVELOPMENT_QA_CREDENTIALS.email,
				initials: "WH",
			},
			expiresAtMs: nowMs + 12 * 60 * 60 * 1_000,
		};
		return structuredClone(this.session);
	}

	restore(nowMs = Date.now()): DataCenterAuthSessionProjection | null {
		if (!this.session || this.session.expiresAtMs <= nowMs) {
			this.session = null;
			return null;
		}
		return structuredClone(this.session);
	}

	signOut(): void {
		this.session = null;
	}
}
