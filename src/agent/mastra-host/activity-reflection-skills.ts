import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ACTIVITY_REFLECTION_NATIVE_SKILL_NAMES } from "../activity-reflection-skill-names";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));

/**
 * The source tree uses the repository Skill directory. The packaged and
 * bundled Sidecar instead receives an identical `agent/skills` directory next
 * to this module. Do not resolve relative to process.cwd(): a desktop app has
 * no stable working directory.
 */
function resolveActivityReflectionSkillDirectory(): string {
	const candidates = [
		resolve(moduleDirectory, "skills"),
		resolve(moduleDirectory, "../../../skills"),
	];
	const directory = candidates.find((candidate) =>
		ACTIVITY_REFLECTION_NATIVE_SKILL_NAMES.every((name) =>
			existsSync(resolve(candidate, name, "SKILL.md")),
		),
	);
	if (!directory) {
		throw new Error(
			"WhaleHall 的 Mastra 活动反思 Skill 未随 Sidecar 提供；需要 activity-reflection-analysis 与 activity-reflection-scoring。",
		);
	}
	return directory;
}

export const activityReflectionNativeSkillDirectory =
	resolveActivityReflectionSkillDirectory();

/**
 * Filesystem Skill inputs consumed directly by Mastra's native Agent Skills
 * support. Mastra resolves their SKILL.md and serves references locally via
 * its read-only skill meta-tools.
 */
export const activityReflectionNativeSkillPaths =
	ACTIVITY_REFLECTION_NATIVE_SKILL_NAMES.map((name) =>
		resolve(activityReflectionNativeSkillDirectory, name),
	);
