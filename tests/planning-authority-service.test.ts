import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CalendarRepository } from "../src/bun/calendar-repository";
import {
	CredentialHelperError,
	type CredentialKeyReference,
	type CredentialKeyStore,
} from "../src/bun/credential-helper-client";
import { EncryptedAgentRepository } from "../src/bun/encrypted-agent-repository";
import type { LocalTestSessionIdentity } from "../src/bun/local-test-auth-session";
import { PlanningAuthorityService } from "../src/bun/planning-authority-service";
import type {
	PlanningAuthorityDraft,
	PlanningAuthorityInput,
} from "../src/shared/planning-authority";
import type { ActiveGoalContextV1 } from "../src/shared/goal-context";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("PlanningAuthorityService", () => {
	test("keeps a committed calendar successful while retrying a durable goal effect", async () => {
		const harness = createHarness();
		let failEffect = true;
		let effectCalls = 0;
		const service = harness.service(async (goal) => {
			effectCalls += 1;
			if (failEffect) throw new Error("event journal unavailable");
			return { ...goal, version: effectCalls };
		});
		const input = planningInput("完成本地规划闭环");
		const draft = planningDraft(input, "plan-1", "proposal-1", 0);
		const saved = await service.saveDraft({
			requestId: "save-1",
			expectedRevision: null,
			input,
			draft,
		});
		expect(saved).toEqual(expect.objectContaining({
			kind: "success",
			data: expect.objectContaining({ revision: 1, status: "draft" }),
		}));

		const first = await service.commitDraft({
			requestId: "commit-request-1",
			commitId: "commit-1",
			expectedRevision: 1,
			expectedCalendarRevision: 0,
		});
		expect(first).toEqual(expect.objectContaining({
			kind: "success",
			data: expect.objectContaining({
				calendarCommitted: true,
				effectsApplied: false,
				idempotent: false,
				snapshot: expect.objectContaining({
					status: "committed",
					commit: expect.objectContaining({
						effect: expect.objectContaining({ status: "pending", attempts: 1 }),
					}),
				}),
			}),
		}));
		await expect(harness.repository.getCalendarRevision("account-a")).resolves.toBe(1);
		await expect(
			harness.repository.getCalendarEvent("account-a", "proposal-1"),
		).resolves.toEqual(expect.objectContaining({
			event: expect.objectContaining({ state: "committed", sourcePlanId: "plan-1" }),
		}));

		failEffect = false;
		const retried = await service.commitDraft({
			requestId: "commit-request-retry",
			commitId: "commit-1",
			expectedRevision: 1,
			expectedCalendarRevision: 0,
		});
		expect(retried).toEqual(expect.objectContaining({
			kind: "success",
			data: expect.objectContaining({
				calendarCommitted: true,
				effectsApplied: true,
				idempotent: true,
				snapshot: expect.objectContaining({
					commit: expect.objectContaining({
						effect: expect.objectContaining({ status: "applied", attempts: 2 }),
					}),
				}),
			}),
		}));
		expect(effectCalls).toBe(2);
		await expect(harness.repository.getCalendarRevision("account-a")).resolves.toBe(1);
		harness.activeGoals.delete("account-a");
		const rehydrated = await service.load();
		expect(rehydrated).toEqual(expect.objectContaining({
			kind: "success",
			data: expect.objectContaining({
				commit: expect.objectContaining({
					effect: expect.objectContaining({ status: "applied", attempts: 3 }),
				}),
			}),
		}));
		expect(effectCalls).toBe(3);
		await expect(harness.repository.getCalendarRevision("account-a")).resolves.toBe(1);
		harness.repository.close();
	});

	test("restores pending effects, preserves the last confirmed goal, and isolates accounts", async () => {
		const harness = createHarness();
		let failEffect = true;
		const service = harness.service(async (goal) => {
			if (failEffect) throw new Error("temporary reflection failure");
			return { ...goal, version: 7 };
		});
		const firstInput = planningInput("第一份计划");
		const firstDraft = planningDraft(firstInput, "plan-1", "proposal-1", 0);
		await service.saveDraft({
			requestId: "save-first",
			expectedRevision: null,
			input: firstInput,
			draft: firstDraft,
		});
		const firstCommit = await service.commitDraft({
			requestId: "commit-first",
			commitId: "commit-first",
			expectedRevision: 1,
			expectedCalendarRevision: 0,
		});
		expect(firstCommit.kind).toBe("success");

		failEffect = false;
		const restored = await service.load();
		expect(restored).toEqual(expect.objectContaining({
			kind: "success",
			data: expect.objectContaining({
				status: "committed",
				activeGoal: expect.objectContaining({ text: "第一份计划", version: 7 }),
				commit: expect.objectContaining({
					effect: expect.objectContaining({ status: "applied" }),
				}),
			}),
		}));
		if (restored.kind !== "success" || !restored.data) throw new Error("restore failed");

		const secondInput = planningInput("第二份计划");
		const secondDraft = planningDraft(secondInput, "plan-2", "proposal-2", 1);
		const nextDraft = await service.saveDraft({
			requestId: "save-second",
			expectedRevision: restored.data.revision,
			input: secondInput,
			draft: secondDraft,
		});
		expect(nextDraft).toEqual(expect.objectContaining({
			kind: "success",
			data: expect.objectContaining({
				status: "draft",
				activeGoal: expect.objectContaining({ text: "第一份计划" }),
				confirmedPlan: expect.objectContaining({ id: "plan-1" }),
			}),
		}));
		if (nextDraft.kind !== "success") throw new Error("save failed");

		const reused = await service.commitDraft({
			requestId: "reuse-old-commit",
			commitId: "commit-first",
			expectedRevision: nextDraft.data.revision,
			expectedCalendarRevision: 1,
		});
		expect(reused.kind).not.toBe("success");
		await expect(harness.repository.getCalendarRevision("account-a")).resolves.toBe(1);

		harness.identity = identity("account-b", 2);
		await expect(service.load()).resolves.toEqual({ kind: "success", data: null });
		const accountBInput = planningInput("B 账户计划");
		const accountBSaved = await service.saveDraft({
			requestId: "save-account-b",
			expectedRevision: null,
			input: accountBInput,
			draft: planningDraft(accountBInput, "plan-b", "proposal-b", 0),
		});
		expect(accountBSaved.kind).toBe("success");

		harness.identity = identity("account-a", 3);
		const accountARestored = await service.load();
		expect(accountARestored).toEqual(expect.objectContaining({
			kind: "success",
			data: expect.objectContaining({
				input: expect.objectContaining({ goal: "第二份计划" }),
			}),
		}));
		harness.repository.close();
	});

	test("rejects unknown, oversized, and broken nested planning records before persistence", async () => {
		const harness = createHarness();
		const service = harness.service(async (goal) => ({ ...goal, version: 1 }));
		const input = planningInput("严格验证计划");
		const base = planningDraft(input, "plan-validate", "proposal-validate", 0);
		const unknownPlanField = structuredClone(base) as PlanningAuthorityDraft & {
			plan: PlanningAuthorityDraft["plan"] & { trace: string };
		};
		unknownPlanField.plan.trace = "must-not-cross-renderer-boundary";
		const unknownPhaseField = structuredClone(base) as PlanningAuthorityDraft;
		(unknownPhaseField.plan.phases[0] as unknown as Record<string, unknown>).providerMetadata = {};
		const brokenTaskReference = structuredClone(base) as PlanningAuthorityDraft;
		(brokenTaskReference.plan.tasks[0] as { phaseId: string }).phaseId = "missing-phase";
		const oversizedBusyWindow = structuredClone(base) as PlanningAuthorityDraft & {
			busyWindows: Array<Record<string, unknown>>;
		};
		oversizedBusyWindow.busyWindows = [{
			id: "busy-1",
			title: "超".repeat(513),
			kind: "manual-block",
			start: "2026-08-03T03:00:00.000Z",
			end: "2026-08-03T04:00:00.000Z",
			timeZone: "Asia/Shanghai",
		}];
		const brokenConflictReference = structuredClone(base) as PlanningAuthorityDraft & {
			conflicts: Array<Record<string, unknown>>;
		};
		brokenConflictReference.conflicts = [{
			proposalId: "missing-proposal",
			busyWindowId: null,
			reason: "agent-validation",
			severity: "error",
			message: "invalid",
			suggestions: ["move-session"],
		}];
		const invalidDate = structuredClone(base) as PlanningAuthorityDraft;
		(invalidDate.plan as { deadline: string }).deadline = "2026-02-31";

		for (const [index, draft] of [
			unknownPlanField,
			unknownPhaseField,
			brokenTaskReference,
			oversizedBusyWindow as unknown as PlanningAuthorityDraft,
			brokenConflictReference as unknown as PlanningAuthorityDraft,
			invalidDate,
		].entries()) {
			const result = await service.saveDraft({
				requestId: `malformed-${index}`,
				expectedRevision: null,
				input,
				draft,
			});
			expect(result.kind).toBe("error");
			await expect(harness.repository.getPlanningAuthority("account-a")).resolves.toBeNull();
		}
		harness.repository.close();
	});

	test("blocks a calendar transaction when logout occurs during pre-commit preparation", async () => {
		const harness = createHarness();
		const normal = harness.service(async (goal) => ({ ...goal, version: 1 }));
		const input = planningInput("退出登录竞态计划");
		await normal.saveDraft({
			requestId: "save-before-logout",
			expectedRevision: null,
			input,
			draft: planningDraft(input, "plan-logout", "proposal-logout", 0),
		});
		let markStarted!: () => void;
		let release!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const wait = new Promise<void>((resolve) => {
			release = resolve;
		});
		const repository = harness.repository;
		const gatedRepository: ConstructorParameters<typeof PlanningAuthorityService>[0]["repository"] = {
			getPlanningAuthority: (accountId) => repository.getPlanningAuthority(accountId),
			compareAndSetPlanningAuthority: (accountId, snapshot, revision, beforeCommit) =>
				repository.compareAndSetPlanningAuthority(accountId, snapshot, revision, beforeCommit),
			commitCalendarAndPlanningAuthority: async (accountId, commit) => {
				markStarted();
				await wait;
				return repository.commitCalendarAndPlanningAuthority(accountId, commit);
			},
		};
		const committing = harness.service(
			async (goal) => ({ ...goal, version: 1 }),
			gatedRepository,
		).commitDraft({
			requestId: "commit-during-logout",
			commitId: "commit-during-logout",
			expectedRevision: 1,
			expectedCalendarRevision: 0,
		});
		await started;
		harness.identity = identity("account-b", 2);
		release();
		const result = await committing;
		expect(result.kind).toBe("unavailable");
		await expect(repository.getCalendarRevision("account-a")).resolves.toBe(0);
		await expect(repository.getCalendarEvent("account-a", "proposal-logout")).resolves.toBeNull();
		await expect(repository.getPlanningAuthority("account-a")).resolves.toEqual(
			expect.objectContaining({ status: "draft", revision: 1 }),
		);
		repository.close();
	});

	test("never reports an old pending-effect RPC as successful after logout", async () => {
		const harness = createHarness();
		const failing = harness.service(async () => {
			throw new Error("reflection unavailable");
		});
		const input = planningInput("退出时等待目标副作用");
		await failing.saveDraft({
			requestId: "save-pending-logout",
			expectedRevision: null,
			input,
			draft: planningDraft(input, "plan-pending-logout", "proposal-pending-logout", 0),
		});
		const first = await failing.commitDraft({
			requestId: "commit-pending-logout",
			commitId: "commit-pending-logout",
			expectedRevision: 1,
			expectedCalendarRevision: 0,
		});
		expect(first).toEqual(expect.objectContaining({
			kind: "success",
			data: expect.objectContaining({ effectsApplied: false }),
		}));

		let markStarted!: () => void;
		let release!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const wait = new Promise<void>((resolve) => {
			release = resolve;
		});
		const gated = harness.service(async () => {
			markStarted();
			await wait;
			throw new Error("session changed");
		});
		const retry = gated.commitDraft({
			requestId: "retry-pending-logout",
			commitId: "commit-pending-logout",
			expectedRevision: 1,
			expectedCalendarRevision: 0,
		});
		await started;
		harness.identity = identity("account-b", 2);
		release();
		expect((await retry).kind).toBe("unavailable");
		await expect(harness.repository.getCalendarRevision("account-a")).resolves.toBe(1);
		harness.repository.close();
	});
});

function createHarness(): {
	repository: EncryptedAgentRepository;
	identity: LocalTestSessionIdentity;
	activeGoals: Map<string, ActiveGoalContextV1>;
	service(
		applyActiveGoal: ConstructorParameters<typeof PlanningAuthorityService>[0]["applyActiveGoal"],
		repositoryOverride?: ConstructorParameters<typeof PlanningAuthorityService>[0]["repository"],
	): PlanningAuthorityService;
} {
	const directory = mkdtempSync(join(tmpdir(), "whalehall-planning-authority-"));
	temporaryDirectories.push(directory);
	const repository = new EncryptedAgentRepository({
		databasePath: join(directory, "agent.sqlite3"),
		installationId: "install-1",
		keyStore: new MemoryKeyStore(),
		now: () => 70_000,
	});
	const calendar = new CalendarRepository(repository, {
		timeZone: () => "Asia/Shanghai",
		now: () => 70_000,
	});
	const harness = {
		repository,
		identity: identity("account-a", 1),
		activeGoals: new Map<string, ActiveGoalContextV1>(),
		service(
			applyActiveGoal: ConstructorParameters<typeof PlanningAuthorityService>[0]["applyActiveGoal"],
			repositoryOverride?: ConstructorParameters<typeof PlanningAuthorityService>[0]["repository"],
		) {
			return new PlanningAuthorityService({
				currentSession: () => harness.identity,
				isCurrentSession: (candidate) =>
					candidate.accountId === harness.identity.accountId &&
					candidate.sessionId === harness.identity.sessionId &&
					candidate.generation === harness.identity.generation,
				repository: repositoryOverride ?? repository,
				calendar,
				currentActiveGoal: (accountId) => harness.activeGoals.get(accountId) ?? null,
				applyActiveGoal: async (goal) => {
					const normalized = await applyActiveGoal(goal);
					harness.activeGoals.set(harness.identity.accountId, normalized);
					return normalized;
				},
				now: () => 70_000,
			});
		},
	};
	return harness;
}

function identity(accountId: string, generation: number): LocalTestSessionIdentity {
	return { accountId, generation, sessionId: `session-${accountId}-${generation}` };
}

function planningInput(goal: string): PlanningAuthorityInput {
	return {
		goal,
		type: "short-term",
		deadline: "2026-08-31",
		priority: "high",
		weeklyCapacityHours: 8,
		unavailableDays: [],
		preferredSessionMinutes: 60,
		preferredDayPart: "morning",
	};
}

function planningDraft(
	input: PlanningAuthorityInput,
	planId: string,
	proposalId: string,
	calendarRevision: number,
): PlanningAuthorityDraft {
	const taskId = `task-${planId}`;
	return {
		plan: {
			id: planId,
			type: input.type,
			title: input.goal,
			goal: input.goal,
			deadline: input.deadline,
			priority: input.priority,
			weeklyCapacityHours: input.weeklyCapacityHours,
			calendarRevision,
			totalEstimatedMinutes: 60,
			phases: [{ id: `phase-${planId}`, title: "阶段", objective: input.goal, order: 1 }],
			milestones: [],
			tasks: [{
				id: taskId,
				phaseId: `phase-${planId}`,
				milestoneId: null,
				title: input.goal,
				estimatedMinutes: 60,
			}],
			scheduleWindow: { startDate: "2026-08-01", endDateExclusive: "2026-09-01" },
			generationRun: {
				id: `run-${planId}`,
				startedAt: "2026-08-01T00:00:00.000Z",
				completedAt: "2026-08-01T00:01:00.000Z",
				statuses: ["understood", "ready"],
				revision: 1,
			},
		},
		proposals: [{
			id: proposalId,
			sourcePlanId: planId,
			taskId,
			title: input.goal,
			state: "proposed",
			start: "2026-08-03T01:00:00.000Z",
			end: "2026-08-03T02:00:00.000Z",
			timeZone: "Asia/Shanghai",
			version: 0,
		}],
		busyWindows: [],
		conflicts: [],
		suggestions: [],
	};
}

class MemoryKeyStore implements CredentialKeyStore {
	private readonly keys = new Map<string, Uint8Array>();

	async getKey(reference: CredentialKeyReference): Promise<Uint8Array> {
		const key = this.keys.get(referenceKey(reference));
		if (!key) throw new CredentialHelperError("NOT_FOUND");
		return key.slice();
	}

	async createKey(reference: CredentialKeyReference): Promise<Uint8Array> {
		const id = referenceKey(reference);
		if (this.keys.has(id)) throw new CredentialHelperError("ALREADY_EXISTS");
		const key = Uint8Array.from({ length: 32 }, (_, index) => (index * 17 + 31) & 0xff);
		this.keys.set(id, key);
		return key.slice();
	}

	async deleteKey(reference: CredentialKeyReference): Promise<{ deleted: boolean }> {
		return { deleted: this.keys.delete(referenceKey(reference)) };
	}
}

function referenceKey(reference: CredentialKeyReference): string {
	return `${reference.installationId}:${reference.accountId}:v${reference.keyVersion}`;
}
