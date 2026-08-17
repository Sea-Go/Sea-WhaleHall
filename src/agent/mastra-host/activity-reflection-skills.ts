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
 * support. The local catalog resolves the SKILL.md through `agent.getSkill()`
 * before the separate no-Tool reflection Agent makes its model call.
 */
export const activityReflectionNativeSkillPaths =
	ACTIVITY_REFLECTION_NATIVE_SKILL_NAMES.map((name) =>
		resolve(activityReflectionNativeSkillDirectory, name),
	);

/**
 * Minimal surface of Mastra's documented `agent.getSkill()` API. Keeping this
 * structural avoids coupling the host boundary to an Agent implementation
 * detail while retaining Mastra as the sole Skill loader.
 */
export interface ActivityReflectionSkillCatalog {
	getSkill(name: string): Promise<{ instructions: string } | null>;
}

/**
 * Loads the two project Skills locally through Mastra before a remote model call.
 * The current OpenAI-compatible provider does not reliably honor native
 * tool_choice for Skill meta-tools, so a model-driven loading turn would make
 * a valid reflection depend on an unsupported capability. This remains the
 * framework's native Skill source of truth; only the deterministic loading
 * decision belongs to the local client.
 *
 * The returned content intentionally contains no filesystem locations,
 * references, raw window data, or credentials. It is safe to place beside the
 * existing local system instructions in the one model request.
 */
export async function loadActivityReflectionNativeSkillContext(
	catalog: ActivityReflectionSkillCatalog,
): Promise<{ role: "system"; content: string }> {
	const skills = await Promise.all(
		ACTIVITY_REFLECTION_NATIVE_SKILL_NAMES.map((name) =>
			catalog.getSkill(name),
		),
	);
	if (skills.some((skill) => skill === null)) {
		throw new Error("WhaleHall 的 Mastra 活动反思 Skill 无法在本地加载。");
	}
	const instructions = skills.map((skill, index) => {
		const value = skill?.instructions;
		if (typeof value !== "string" || !value.trim()) {
			throw new Error(
				`WhaleHall 的 Mastra 活动反思 Skill 缺少说明：${ACTIVITY_REFLECTION_NATIVE_SKILL_NAMES[index] ?? "unknown"}。`,
			);
		}
		return value.trim();
	});
	const [analysisInstructions, scoringInstructions] = instructions;
	if (!analysisInstructions || !scoringInstructions) {
		throw new Error("WhaleHall 的 Mastra 活动反思 Skill 无法在本地加载。");
	}
	return {
		role: "system",
		content: [
			"以下两份规则已由客户端通过 Mastra 原生 Skill API 在本地加载。它们是本轮的权威规则；不要再次调用任何 Tool，直接按规则输出。",
			"# 已加载的活动反思分析 Skill",
			analysisInstructions,
			"# 已加载的活动反思评分 Skill",
			scoringInstructions,
			"输出前再次核对：每个 action 必须以“确定：”“推测：”或“不确定：”开头，后面必须是具体的简体中文活动描述。例如：推测：正在编写代码并查阅技术资料。不能把 development、communication 等英文枚举写入 action。",
		].join("\n\n"),
	};
}
