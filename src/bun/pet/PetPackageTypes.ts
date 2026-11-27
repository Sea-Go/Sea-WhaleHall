/**
 * 桌宠资源包 v1 类型与校验器(《桌宠包标准 v1》的实现侧)。
 *
 * 本模块是宿主内核的一部分,遵守桌宠无关性硬约束:不包含任何具体形象
 * 的知识;词表封闭;一切差异经包声明进入。校验器手写守卫,零依赖,
 * 供 PetPackageManager(运行时)与 verify-pet-pack(构建期)共用。
 */

export const PET_PACKAGE_SCHEMA = "whalehall.pet-package.v1" as const;
export const PET_ACTIONS_SCHEMA = "whalehall.pet-actions.v1" as const;
export const PET_BEHAVIORS_SCHEMA = "whalehall.pet-behaviors.v1" as const;
export const STICKER_PACK_SCHEMA = "whalehall.sticker-pack.v1" as const;

export const PET_RENDERER_KINDS = ["sequence", "live2d"] as const;
export type PetRendererKind = (typeof PET_RENDERER_KINDS)[number];

export const PET_HIT_ZONE_IDS = [
	"head",
	"face",
	"body",
	"tail",
	"limb",
] as const;
export type PetHitZoneId = (typeof PET_HIT_ZONE_IDS)[number];

export const PET_TONES = [
	"neutral",
	"happy",
	"busy",
	"error",
	"angry",
	"sleepy",
	"love",
	"shy",
	"proud",
	"confused",
	"afraid",
	"focused",
	"sick",
	"celebration",
] as const;
export type PetToneId = (typeof PET_TONES)[number];

/** 必备动作集(标准 §5):包校验的渲染覆盖硬门槛。 */
export const MANDATORY_ACTIONS = [
	"idle",
	"breathe",
	"blink",
	"lookAround",
	"stretch",
	"yawn",
	"walkLeft",
	"walkRight",
	"turnLeft",
	"turnRight",
	"sitDown",
	"standUp",
	"dragged",
	"drop",
	"clickFeedback",
	"sleepIn",
	"sleepLoop",
	"wake",
	"enter",
	"exit",
] as const;

/** 宿主保留态(标准 §4):包不可定义,解释器强制系统不变量。 */
export const RESERVED_BEHAVIOR_STATES = [
	"dragged",
	"drop",
	"hidden",
	"exit",
] as const;

/** 参考词表:历史动作目录中除必备外的动作,包作者自选取用。 */
export const REFERENCE_VOCABULARY = [
	"stopWalking", "runLeft", "runRight", "jump", "takeOff", "land",
	"fallDown", "recoverFromFall", "lieDown", "riseFromLie", "slide",
	"climbScreenEdge", "holdWindowEdge", "peekFromEdge", "fallFromHeight",
	"pushedByWindow", "doubleClick", "rapidClickAnnoyed", "hoverLookAtPointer",
	"trackPointerGaze", "dragStruggle", "petHead", "pokeFace", "pokeBody",
	"chasedByPointer", "catchPointer", "sitOnPointer", "pushPointerAway",
	"happy", "laugh", "shy", "angry", "wronged", "sad", "cry", "surprised",
	"afraid", "confused", "bored", "sleepy", "proud", "impatient",
	"expectant", "loveReaction", "eat", "drink", "receiveFood", "refuseFood",
	"full", "hungry", "bathe", "dryOff", "groom", "playToy", "readBook",
	"usePhone", "listenMusic", "exercise", "sick", "takeMedicine",
	"recoverEnergy", "levelUp", "receiveGift", "unwrapGift", "changeOutfit",
	"remindUser", "holdSign", "knockScreen", "pointNotification", "think",
	"searching", "loading", "answerQuestion", "recordTodo", "startPomodoro",
	"focus", "breakReminder", "alarm", "taskComplete", "operationFailed",
	"networkDisconnected", "updateComplete", "morningWakeUp", "lunchTime",
	"eveningSleepy", "lateNightRestReminder", "birthdayCelebrate",
	"holidayAction", "rainUmbrella", "winterShiver", "summerFan",
	"idleSelfEntertainment", "welcomeUserBack", "overworkRestReminder",
	"hiddenEasterEgg", "enterToIdle", "idleToWalk", "walkToIdle",
	"walkToTurn", "turnToWalk", "idleToSit", "sitToIdle", "idleToSleep",
	"sleepToWake", "dragToDrop", "takeOffToAirborne", "airborneToLand",
	"idleToExit", "sittingLoop", "lyingLoop", "airborneLoop", "heldLoop",
	"hidden",
] as const;

/** 语义事件词表:与参考词表+必备集同词汇;同名约定派发(标准 §7)。 */
export const SEMANTIC_EVENT_WORDS: readonly string[] = [
	...MANDATORY_ACTIONS,
	...REFERENCE_VOCABULARY,
];

export const STICKER_REF_PATTERN = /^@([a-z][a-z0-9-]{1,31})\/(.+)$/;

export interface PetManifestHitZone {
	id: PetHitZoneId;
	cx: number;
	cy: number;
	rx: number;
	ry: number;
}

export interface PetManifest {
	schema: string;
	id: string;
	label: string;
	version: string;
	renderer: PetRendererKind;
	canvas: { width: number; height: number; groundAnchorY: number };
	sprite: { left: number; top: number };
	tier: "full" | "core";
	fallbackAction: string;
	hitZones: readonly PetManifestHitZone[];
	cover: string;
	authors: readonly string[];
	license: string;
	summary: string;
	default?: boolean;
}

export interface PetActionDefinition {
	id: string;
	clip?: string;
	motionGroup?: string;
	durationMs: number;
	loop: boolean;
	next?: string;
	facing?: -1 | 0 | 1;
	cues?: readonly string[];
}

export interface PetActionsFile {
	schema: string;
	actions: readonly PetActionDefinition[];
	toneMap?: Readonly<Record<string, string>>;
}

export type PetTransitionCondition =
	| { on: "timer"; afterMs: [number, number]; to: string; weight?: number }
	| { on: "expire"; to: string }
	| { on: "schedule"; hours: readonly [number, number][]; to: string }
	| {
			on:
				| "pointer:hover"
				| "pointer:click"
				| "pointer:pet"
				| "pointer:poke"
				| "pointer:drag"
				| "pointer:drop";
			to: string;
	  }
	| { on: "system:enter" | "system:exit" | "system:hidden" | "system:visibility"; to: string }
	| { on: `environment:${string}`; to: string };

export interface PetBehaviorState {
	action: string;
	duration?: [number, number];
	holdMs?: number;
	transitions?: readonly PetTransitionCondition[];
}

export interface PetRoutineStep {
	action: string;
	holdMs: number;
}

export interface PetRoutine {
	id: string;
	steps: readonly PetRoutineStep[];
}

export interface PetBehaviorsFile {
	schema: string;
	movement: {
		locomotion: "ground" | "air" | "water" | "teleport";
		speedPxPerSec?: Readonly<Record<string, number>>;
		gravity?: boolean;
		edges?: "turn" | "bounce" | "climb" | "fall";
		windowEdges?: "hold" | "push" | "ignore";
	};
	stateMachine: {
		initial: string;
		states: Readonly<Record<string, PetBehaviorState>>;
	};
	routines?: readonly PetRoutine[];
	emotionMap?: Readonly<Record<string, string>>;
}

export interface StickerEntry {
	id: string;
	file: string;
	durationMs: number;
	tags?: readonly string[];
}

export interface StickerPackFile {
	schema: string;
	id: string;
	label: string;
	version: string;
	cover: string;
	license: string;
	stickers: readonly StickerEntry[];
}

export type PetTier = "full" | "core" | "rejected";

export interface PetPackageValidationError {
	field: string;
	message: string;
}

const ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireFields(
	value: Record<string, unknown>,
	fields: readonly string[],
	errors: PetPackageValidationError[],
): void {
	for (const field of fields) {
		if (!(field in value)) {
			errors.push({ field, message: "缺失必填字段" });
		}
	}
}

function rejectUnknownFields(
	value: Record<string, unknown>,
	allowed: readonly string[],
	errors: PetPackageValidationError[],
): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) {
			errors.push({ field: key, message: "未知字段(拒绝)" });
		}
	}
}

export function validatePetManifest(
	dirName: string,
	raw: unknown,
): { manifest?: PetManifest; errors: PetPackageValidationError[] } {
	const errors: PetPackageValidationError[] = [];
	if (!isRecord(raw)) {
		return { errors: [{ field: "$", message: "清单必须是对象" }] };
	}
	requireFields(
		raw,
		[
			"schema",
			"id",
			"label",
			"version",
			"renderer",
			"canvas",
			"sprite",
			"tier",
			"fallbackAction",
			"hitZones",
			"cover",
			"authors",
			"license",
			"summary",
		],
		errors,
	);
	rejectUnknownFields(
		raw,
		[
			"schema",
			"id",
			"label",
			"version",
			"renderer",
			"canvas",
			"sprite",
			"tier",
			"fallbackAction",
			"hitZones",
			"cover",
			"authors",
			"license",
			"summary",
			"default",
		],
		errors,
	);
	if (errors.length > 0) return { errors };

	if (raw.schema !== PET_PACKAGE_SCHEMA) {
		errors.push({ field: "schema", message: `必须是 ${PET_PACKAGE_SCHEMA}` });
	}
	if (typeof raw.id !== "string" || !ID_PATTERN.test(raw.id)) {
		errors.push({ field: "id", message: "不符合 ^[a-z][a-z0-9-]{1,31}$" });
	} else if (raw.id !== dirName) {
		errors.push({ field: "id", message: `目录名(${dirName})必须等于 id` });
	}
	if (typeof raw.label !== "string" || raw.label.length < 1 || raw.label.length > 32) {
		errors.push({ field: "label", message: "长度须 1..32" });
	}
	if (typeof raw.version !== "string" || !SEMVER_PATTERN.test(raw.version)) {
		errors.push({ field: "version", message: "不符合 semver" });
	}
	if (
		typeof raw.renderer !== "string" ||
		!PET_RENDERER_KINDS.includes(raw.renderer as PetRendererKind)
	) {
		errors.push({ field: "renderer", message: `必须是 ${PET_RENDERER_KINDS.join("|")}` });
	}
	const canvas = raw.canvas;
	if (
		!isRecord(canvas) ||
		!Number.isFinite(canvas.width) ||
		!Number.isFinite(canvas.height) ||
		!Number.isFinite(canvas.groundAnchorY) ||
		(canvas.width as number) <= 0 ||
		(canvas.height as number) <= 0
	) {
		errors.push({ field: "canvas", message: "width/height/groundAnchorY 须为正数" });
	}
	const sprite = raw.sprite;
	if (
		!isRecord(sprite) ||
		!Number.isFinite(sprite.left) ||
		!Number.isFinite(sprite.top)
	) {
		errors.push({ field: "sprite", message: "left/top 须为数值" });
	}
	if (raw.tier !== "full" && raw.tier !== "core") {
		errors.push({ field: "tier", message: "必须是 full|core" });
	}
	if (typeof raw.fallbackAction !== "string" || raw.fallbackAction.length === 0) {
		errors.push({ field: "fallbackAction", message: "必须是动作 id(闭包校验在跨文件阶段)" });
	}
	if (!Array.isArray(raw.hitZones)) {
		errors.push({ field: "hitZones", message: "必须是数组" });
	} else {
		for (const zone of raw.hitZones) {
			if (
				!isRecord(zone) ||
				typeof zone.id !== "string" ||
				!PET_HIT_ZONE_IDS.includes(zone.id as PetHitZoneId) ||
				!Number.isFinite(zone.cx) ||
				!Number.isFinite(zone.cy) ||
				!Number.isFinite(zone.rx) ||
				!Number.isFinite(zone.ry)
			) {
				errors.push({ field: "hitZones", message: `非法命中区 ${JSON.stringify(zone)}` });
			}
		}
	}
	if (typeof raw.cover !== "string" || raw.cover.length === 0) {
		errors.push({ field: "cover", message: "必须是文件名" });
	}
	if (!Array.isArray(raw.authors) || raw.authors.length === 0) {
		errors.push({ field: "authors", message: "必须是非空数组" });
	}
	if (typeof raw.license !== "string" || raw.license.length === 0) {
		errors.push({ field: "license", message: "必填(细节记 SKIN.md)" });
	}
	if (typeof raw.summary !== "string" || raw.summary.length > 120) {
		errors.push({ field: "summary", message: "≤120 字符" });
	}
	if ("default" in raw && typeof raw.default !== "boolean") {
		errors.push({ field: "default", message: "必须是布尔" });
	}
	if (errors.length > 0) return { errors };
	return {
		manifest: raw as unknown as PetManifest,
		errors: [],
	};
}

export function validatePetActions(
	raw: unknown,
): { actions?: PetActionsFile; errors: PetPackageValidationError[] } {
	const errors: PetPackageValidationError[] = [];
	if (!isRecord(raw)) {
		return { errors: [{ field: "$", message: "动作表必须是对象" }] };
	}
	requireFields(raw, ["schema", "actions"], errors);
	rejectUnknownFields(raw, ["schema", "actions", "toneMap"], errors);
	if (errors.length > 0) return { errors };
	if (raw.schema !== PET_ACTIONS_SCHEMA) {
		errors.push({ field: "schema", message: `必须是 ${PET_ACTIONS_SCHEMA}` });
	}
	if (!Array.isArray(raw.actions) || raw.actions.length === 0) {
		errors.push({ field: "actions", message: "必须是非空数组" });
		return { errors };
	}
	const seen = new Set<string>();
	for (const entry of raw.actions) {
		if (!isRecord(entry)) {
			errors.push({ field: "actions", message: "条目必须是对象" });
			continue;
		}
		rejectUnknownFields(
			entry,
			["id", "clip", "motionGroup", "durationMs", "loop", "next", "facing", "cues"],
			errors,
		);
		if (typeof entry.id !== "string" || entry.id.length === 0) {
			errors.push({ field: "actions.id", message: "非法动作 id" });
			continue;
		}
		if (seen.has(entry.id)) {
			errors.push({ field: "actions.id", message: `动作 ${entry.id} 重复` });
		}
		seen.add(entry.id);
		const hasClip = typeof entry.clip === "string" && entry.clip.length > 0;
		const hasMotion =
			typeof entry.motionGroup === "string" && entry.motionGroup.length > 0;
		if (hasClip === hasMotion) {
			errors.push({
				field: "actions.clip",
				message: `动作 ${entry.id}:clip 与 motionGroup 必须二选一`,
			});
		}
		if (
			!Number.isFinite(entry.durationMs) ||
			(entry.durationMs as number) < 200 ||
			(entry.durationMs as number) > 20_000
		) {
			errors.push({
				field: "actions.durationMs",
				message: `动作 ${entry.id}:须 200..20000`,
			});
		}
		if (typeof entry.loop !== "boolean") {
			errors.push({ field: "actions.loop", message: `动作 ${entry.id}:loop 必须是布尔` });
		}
		if (
			entry.facing !== undefined &&
			![-1, 0, 1].includes(entry.facing as number)
		) {
			errors.push({ field: "actions.facing", message: `动作 ${entry.id}:facing 须 -1|0|1` });
		}
	}
	if (raw.toneMap !== undefined) {
		if (!isRecord(raw.toneMap)) {
			errors.push({ field: "toneMap", message: "必须是对象" });
		} else {
			for (const [tone, action] of Object.entries(raw.toneMap)) {
				if (!PET_TONES.includes(tone as PetToneId)) {
					errors.push({ field: "toneMap", message: `未知 tone ${tone}` });
				}
				if (typeof action !== "string" || action.length === 0) {
					errors.push({ field: "toneMap", message: `tone ${tone} 的值必须是动作 id` });
				}
			}
		}
	}
	if (errors.length > 0) return { errors };
	return { actions: raw as unknown as PetActionsFile, errors: [] };
}

const POINTER_EVENTS = [
	"pointer:hover",
	"pointer:click",
	"pointer:pet",
	"pointer:poke",
	"pointer:drag",
	"pointer:drop",
] as const;
const SYSTEM_EVENTS = [
	"system:enter",
	"system:exit",
	"system:hidden",
	"system:visibility",
] as const;

function isValidTransition(value: unknown): boolean {
	if (!isRecord(value) || typeof value.on !== "string" || typeof value.to !== "string") {
		return false;
	}
	const on = value.on;
	if (on === "timer") {
		return (
			Array.isArray(value.afterMs) &&
			value.afterMs.length === 2 &&
			Number.isFinite(value.afterMs[0]) &&
			Number.isFinite(value.afterMs[1]) &&
			(value.afterMs[0] as number) <= (value.afterMs[1] as number) &&
			(value.weight === undefined || Number.isFinite(value.weight))
		);
	}
	if (on === "expire") return true;
	if (on === "schedule") {
		return (
			Array.isArray(value.hours) &&
			value.hours.every(
				(range) =>
					Array.isArray(range) &&
					range.length === 2 &&
					Number.isFinite(range[0]) &&
					Number.isFinite(range[1]),
			)
		);
	}
	if ((POINTER_EVENTS as readonly string[]).includes(on)) return true;
	if ((SYSTEM_EVENTS as readonly string[]).includes(on)) return true;
	if (on.startsWith("environment:")) return on.length > "environment:".length;
	return false;
}

export function validatePetBehaviors(
	raw: unknown,
): { behaviors?: PetBehaviorsFile; errors: PetPackageValidationError[] } {
	const errors: PetPackageValidationError[] = [];
	if (!isRecord(raw)) {
		return { errors: [{ field: "$", message: "行为定义必须是对象" }] };
	}
	requireFields(raw, ["schema", "movement", "stateMachine"], errors);
	rejectUnknownFields(
		raw,
		["schema", "movement", "stateMachine", "routines", "emotionMap"],
		errors,
	);
	if (errors.length > 0) return { errors };
	if (raw.schema !== PET_BEHAVIORS_SCHEMA) {
		errors.push({ field: "schema", message: `必须是 ${PET_BEHAVIORS_SCHEMA}` });
	}
	const movement = raw.movement;
	if (
		!isRecord(movement) ||
		!["ground", "air", "water", "teleport"].includes(
			String(movement.locomotion),
		)
	) {
		errors.push({
			field: "movement.locomotion",
			message: "必须是 ground|air|water|teleport",
		});
	} else {
		rejectUnknownFields(
			movement,
			["locomotion", "speedPxPerSec", "gravity", "edges", "windowEdges"],
			errors,
		);
		if (
			movement.edges !== undefined &&
			!["turn", "bounce", "climb", "fall"].includes(String(movement.edges))
		) {
			errors.push({ field: "movement.edges", message: "必须是 turn|bounce|climb|fall" });
		}
		if (
			movement.windowEdges !== undefined &&
			!["hold", "push", "ignore"].includes(String(movement.windowEdges))
		) {
			errors.push({
				field: "movement.windowEdges",
				message: "必须是 hold|push|ignore",
			});
		}
	}
	const machine = raw.stateMachine;
	if (
		!isRecord(machine) ||
		typeof machine.initial !== "string" ||
		!isRecord(machine.states) ||
		Object.keys(machine.states).length === 0
	) {
		errors.push({ field: "stateMachine", message: "须含 initial 与非空 states" });
		return { errors };
	}
	for (const [name, state] of Object.entries(machine.states)) {
		if ((RESERVED_BEHAVIOR_STATES as readonly string[]).includes(name)) {
			errors.push({
				field: "stateMachine.states",
				message: `${name} 是宿主保留态,包不可定义`,
			});
			continue;
		}
		if (!isRecord(state) || typeof state.action !== "string") {
			errors.push({ field: `states.${name}`, message: "须含 action 字符串" });
			continue;
		}
		rejectUnknownFields(state, ["action", "duration", "holdMs", "transitions"], errors);
		if (
			state.transitions !== undefined &&
			(!Array.isArray(state.transitions) ||
				state.transitions.some((transition) => !isValidTransition(transition)))
		) {
			errors.push({ field: `states.${name}.transitions`, message: "存在非法转移" });
		}
	}
	if (raw.routines !== undefined) {
		if (!Array.isArray(raw.routines)) {
			errors.push({ field: "routines", message: "必须是数组" });
		} else {
			for (const routine of raw.routines) {
				if (
					!isRecord(routine) ||
					typeof routine.id !== "string" ||
					!Array.isArray(routine.steps) ||
					routine.steps.length === 0
				) {
					errors.push({ field: "routines", message: "例程须含 id 与非空 steps" });
				}
			}
		}
	}
	if (
		raw.emotionMap !== undefined &&
		(!isRecord(raw.emotionMap) ||
			Object.values(raw.emotionMap).some((v) => typeof v !== "string"))
	) {
		errors.push({ field: "emotionMap", message: "值必须是动作 id 或表情引用" });
	}
	if (errors.length > 0) return { errors };
	return { behaviors: raw as unknown as PetBehaviorsFile, errors: [] };
}

export function validateStickerPack(
	dirName: string,
	raw: unknown,
): { pack?: StickerPackFile; errors: PetPackageValidationError[] } {
	const errors: PetPackageValidationError[] = [];
	if (!isRecord(raw)) {
		return { errors: [{ field: "$", message: "清单必须是对象" }] };
	}
	requireFields(raw, ["schema", "id", "label", "version", "cover", "license", "stickers"], errors);
	rejectUnknownFields(
		raw,
		["schema", "id", "label", "version", "cover", "license", "stickers"],
		errors,
	);
	if (errors.length > 0) return { errors };
	if (raw.schema !== STICKER_PACK_SCHEMA) {
		errors.push({ field: "schema", message: `必须是 ${STICKER_PACK_SCHEMA}` });
	}
	if (typeof raw.id !== "string" || !ID_PATTERN.test(raw.id)) {
		errors.push({ field: "id", message: "不符合 id 规则" });
	} else if (raw.id !== dirName) {
		errors.push({ field: "id", message: `目录名(${dirName})必须等于 id` });
	}
	if (typeof raw.license !== "string" || raw.license.length === 0) {
		errors.push({ field: "license", message: "必填(QQ 表情包标注非商用出处)" });
	}
	if (!Array.isArray(raw.stickers) || raw.stickers.length === 0) {
		errors.push({ field: "stickers", message: "必须是非空数组" });
	} else {
		const seen = new Set<string>();
		for (const sticker of raw.stickers) {
			if (
				!isRecord(sticker) ||
				typeof sticker.id !== "string" ||
				sticker.id.length === 0 ||
				typeof sticker.file !== "string" ||
				!sticker.file.endsWith(".gif") ||
				!Number.isFinite(sticker.durationMs) ||
				(sticker.durationMs as number) <= 0
			) {
				errors.push({ field: "stickers", message: `非法条目 ${JSON.stringify(sticker)}` });
				continue;
			}
			if (seen.has(sticker.id)) {
				errors.push({ field: "stickers", message: `表情 ${sticker.id} 重复` });
			}
			seen.add(sticker.id);
		}
	}
	if (errors.length > 0) return { errors };
	return { pack: raw as unknown as StickerPackFile, errors: [] };
}

export interface PetCrossValidationInput {
	manifest: PetManifest;
	actions: PetActionsFile;
	behaviors: PetBehaviorsFile;
}

/** 跨文件引用闭包与状态机可达性校验(标准 §4/§5)。 */
export function crossValidatePetPackage(input: PetCrossValidationInput): PetPackageValidationError[] {
	const { manifest, actions, behaviors } = input;
	const errors: PetPackageValidationError[] = [];
	const actionIds = new Set(actions.actions.map((action) => action.id));
	const ref = (field: string, id: string): void => {
		if (!actionIds.has(id)) {
			errors.push({ field, message: `引用了未定义动作 ${id}` });
		}
	};

	ref("fallbackAction", manifest.fallbackAction);
	for (const action of actions.actions) {
		if (action.clip !== undefined && manifest.renderer !== "sequence") {
			errors.push({ field: "actions.clip", message: "非 sequence 渲染器不得用 clip" });
		}
		if (action.motionGroup !== undefined && manifest.renderer !== "live2d") {
			errors.push({
				field: "actions.motionGroup",
				message: "非 live2d 渲染器不得用 motionGroup",
			});
		}
	}
	if (actions.toneMap !== undefined) {
		for (const [tone, actionId] of Object.entries(actions.toneMap)) {
			ref(`toneMap.${tone}`, actionId);
		}
	}
	for (const action of actions.actions) {
		if (action.next !== undefined) ref(`actions.${action.id}.next`, action.next);
	}

	const states = behaviors.stateMachine.states;
	const stateNames = new Set(Object.keys(states));
	if (!stateNames.has(behaviors.stateMachine.initial)) {
		errors.push({
			field: "stateMachine.initial",
			message: `初始态 ${behaviors.stateMachine.initial} 不存在`,
		});
	}
	for (const [name, state] of Object.entries(states)) {
		ref(`states.${name}.action`, state.action);
		for (const transition of state.transitions ?? []) {
			if (!stateNames.has(transition.to)) {
				errors.push({
					field: `states.${name}.transitions`,
					message: `目标态 ${transition.to} 不存在`,
				});
			}
		}
	}
	for (const routine of behaviors.routines ?? []) {
		for (const step of routine.steps) ref(`routines.${routine.id}`, step.action);
	}
	if (behaviors.emotionMap !== undefined) {
		for (const [event, target] of Object.entries(behaviors.emotionMap)) {
			if (STICKER_REF_PATTERN.test(target)) continue;
			ref(`emotionMap.${event}`, target);
		}
	}

	// 可达性:从 initial 出发的 BFS 必须覆盖全部态(无死态)。
	const reachable = new Set<string>([behaviors.stateMachine.initial]);
	const queue = [behaviors.stateMachine.initial];
	while (queue.length > 0) {
		const current = queue.shift() as string;
		for (const transition of states[current]?.transitions ?? []) {
			if (!reachable.has(transition.to)) {
				reachable.add(transition.to);
				queue.push(transition.to);
			}
		}
	}
	for (const name of stateNames) {
		if (!reachable.has(name)) {
			errors.push({ field: "stateMachine.states", message: `态 ${name} 从 initial 不可达(死态)` });
		}
	}

	// 必备集覆盖。
	const missing = MANDATORY_ACTIONS.filter((id) => !actionIds.has(id));
	if (missing.length > 0) {
		errors.push({
			field: "actions",
			message: `缺少必备动作:${missing.join(", ")}`,
		});
	}
	return errors;
}

/** tier 重算(标准 §5):声明只能降不能升。 */
export function recomputeTier(manifest: PetManifest, actions: PetActionsFile): PetTier {
	const actionIds = new Set(actions.actions.map((action) => action.id));
	if (MANDATORY_ACTIONS.some((id) => !actionIds.has(id))) return "rejected";
	const vocabularyCoverage =
		REFERENCE_VOCABULARY.filter((id) => actionIds.has(id)).length /
		REFERENCE_VOCABULARY.length;
	const computed: PetTier = vocabularyCoverage >= 0.8 ? "full" : "core";
	if (manifest.tier === "core" && computed === "full") return "core";
	return computed;
}

/** 解析动作或表情引用;未定义时按标准走统一回退。 */
export function resolvePetAction(
	manifest: PetManifest,
	actions: PetActionsFile,
	actionId: string,
): { action?: PetActionDefinition; fallbackUsed: boolean } {
	const direct = actions.actions.find((action) => action.id === actionId);
	if (direct !== undefined) return { action: direct, fallbackUsed: false };
	const fallback = actions.actions.find(
		(action) => action.id === manifest.fallbackAction,
	);
	return { action: fallback, fallbackUsed: true };
}
