import {
	PET_ACTION_CATALOG,
	PET_ACTION_CATEGORIES,
	PET_FIRST_RELEASE_CHECKLIST,
	getPetAction,
} from "../../shared/pet-actions";
import type {
	PetActionCategory,
	PetActionDefinition,
	PetActionId,
} from "../../shared/pet-actions";
import { CanvasPetRenderer } from "./CanvasPetRenderer";

const CATEGORY_LABELS: Record<PetActionCategory, string> = {
	basic: "基础",
	movement: "移动",
	pointer: "鼠标交互",
	emotion: "情绪",
	life: "生活",
	function: "功能",
	special: "特殊",
	transition: "过渡",
	internal: "内部态",
};

const CATEGORY_ICONS: Record<PetActionCategory, string> = {
	basic: "◌",
	movement: "↔",
	pointer: "⌁",
	emotion: "♡",
	life: "☕",
	function: "◇",
	special: "✦",
	transition: "∿",
	internal: "·",
};

function requiredElement<T extends HTMLElement>(id: string): T {
	const element = document.getElementById(id);
	if (!element) throw new Error(`Missing #${id}`);
	return element as T;
}

const canvas = requiredElement<HTMLCanvasElement>("stage");
const searchInput = requiredElement<HTMLInputElement>("action-search");
const categoryContainer = requiredElement<HTMLDivElement>("action-categories");
const actionContainer = requiredElement<HTMLDivElement>("action-buttons");
const coverageCount = requiredElement<HTMLSpanElement>("coverage-count");
const filteredCount = requiredElement<HTMLSpanElement>("filtered-count");
const currentActionLabel = requiredElement<HTMLElement>("current-action");
const currentActionId = requiredElement<HTMLElement>("current-action-id");
const actionIcon = requiredElement<HTMLElement>("action-icon");
const frameInfo = requiredElement<HTMLElement>("frame-info");
const eventLog = requiredElement<HTMLElement>("event-log");

let selectedCategory: PetActionCategory | "all" = "all";
let selectedAction: PetActionId = "idle";
let sequenceToken = 0;
let lastFramePaintAt = 0;

function describeInteraction(event: { kind: string; zone?: string | null }): string {
	const labels: Record<string, string> = {
		hover: "光标悬停",
		click: "单击",
		doubleClick: "双击",
		rapidClick: "连续点击",
		pet: "抚摸",
		poke: "轻戳",
		dragStart: "抓起",
		dragMove: "拖动",
		dragEnd: "放下",
	};
	return `${labels[event.kind] ?? event.kind}${event.zone ? ` · ${event.zone}` : ""}`;
}

const renderer = new CanvasPetRenderer({
	model: "whale",
	onInteract: (event) => {
		eventLog.textContent = `${describeInteraction(event)} · ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
	},
	onFrame: (snapshot) => {
		const now = performance.now();
		const action = snapshot.frame.action.id;
		if (action !== selectedAction) selectActionDisplay(action);
		if (now - lastFramePaintAt < 90) return;
		lastFramePaintAt = now;
		frameInfo.textContent = [
			`${snapshot.modelId}`,
			`${Math.round(snapshot.frame.action.progress * 100)}%`,
			`x ${snapshot.frame.root.x.toFixed(1)}`,
			`y ${snapshot.frame.root.y.toFixed(1)}`,
		].join("  ·  ");
	},
});

renderer.mount(canvas);
coverageCount.textContent = `${PET_ACTION_CATALOG.length} 个动作 · 2 个可替换模型 · 生产渲染器在线`;

function selectActionDisplay(id: PetActionId): void {
	selectedAction = id;
	const definition = getPetAction(id);
	currentActionLabel.textContent = definition.label;
	currentActionId.textContent = `${definition.id} · ${CATEGORY_LABELS[definition.category]}`;
	actionIcon.textContent = CATEGORY_ICONS[definition.category];
	for (const button of actionContainer.querySelectorAll<HTMLButtonElement>(".action-button")) {
		button.classList.toggle("active", button.dataset.action === id);
	}
}

function playAction(id: PetActionId, cancelSequence = true): void {
	if (cancelSequence) sequenceToken += 1;
	selectActionDisplay(id);
	renderer.play(id);
	const definition = getPetAction(id);
	eventLog.textContent = `播放 · ${definition.label} · ${definition.motion.template}`;
}

function visibleActions(): readonly PetActionDefinition<PetActionId>[] {
	const query = searchInput.value.trim().toLocaleLowerCase("zh-CN");
	return PET_ACTION_CATALOG.filter((definition) => {
		if (selectedCategory !== "all" && definition.category !== selectedCategory) return false;
		if (!query) return true;
		return `${definition.id} ${definition.label} ${definition.motion.template}`
			.toLocaleLowerCase("zh-CN")
			.includes(query);
	});
}

function renderActionList(): void {
	const actions = visibleActions();
	actionContainer.replaceChildren();
	filteredCount.textContent = `${actions.length} / ${PET_ACTION_CATALOG.length}`;
	if (actions.length === 0) {
		const empty = document.createElement("div");
		empty.className = "empty";
		empty.textContent = "没有匹配的动作";
		actionContainer.append(empty);
		return;
	}

	const fragment = document.createDocumentFragment();
	for (const definition of actions) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "action-button";
		button.dataset.action = definition.id;
		button.classList.toggle("active", definition.id === selectedAction);
		button.title = `${definition.label} · ${definition.motion.template}`;

		const icon = document.createElement("span");
		icon.className = "action-icon";
		icon.textContent = CATEGORY_ICONS[definition.category];
		const copy = document.createElement("span");
		copy.className = "action-copy";
		const label = document.createElement("span");
		label.className = "action-label";
		label.textContent = definition.label;
		const id = document.createElement("span");
		id.className = "action-id";
		id.textContent = definition.id;
		copy.append(label, id);
		const duration = document.createElement("span");
		duration.className = "action-duration";
		duration.textContent = definition.loop ? "循环" : `${(definition.durationMs / 1000).toFixed(1)}s`;
		button.append(icon, copy, duration);
		button.addEventListener("click", () => playAction(definition.id));
		fragment.append(button);
	}
	actionContainer.append(fragment);
}

function renderCategoryTabs(): void {
	categoryContainer.replaceChildren();
	const entries: ReadonlyArray<readonly [PetActionCategory | "all", string]> = [
		["all", "全部"],
		...PET_ACTION_CATEGORIES.map((category) => [category, CATEGORY_LABELS[category]] as const),
	];
	for (const [category, label] of entries) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "category-tab";
		button.classList.toggle("active", category === selectedCategory);
		button.textContent = label;
		button.addEventListener("click", () => {
			selectedCategory = category;
			renderCategoryTabs();
			renderActionList();
		});
		categoryContainer.append(button);
	}
}

async function playFirstReleaseSequence(): Promise<void> {
	const token = ++sequenceToken;
	const ids = PET_FIRST_RELEASE_CHECKLIST.flatMap(({ actionIds }) => actionIds);
	eventLog.textContent = `首发序列 · ${ids.length} 段`;
	for (const id of ids) {
		if (token !== sequenceToken) return;
		playAction(id, false);
		const definition = getPetAction(id);
		const waitMs = definition.loop
			? Math.min(1_200, Math.max(700, definition.durationMs))
			: Math.min(2_200, Math.max(500, definition.durationMs + 160));
		await new Promise<void>((resolve) => window.setTimeout(resolve, waitMs));
	}
	if (token === sequenceToken) playAction("idle", false);
}

searchInput.addEventListener("input", renderActionList);
requiredElement<HTMLButtonElement>("random-action").addEventListener("click", () => {
	const pool = visibleActions();
	const definition = pool[Math.floor(Math.random() * pool.length)] ?? getPetAction("idle");
	playAction(definition.id);
});
requiredElement<HTMLButtonElement>("play-sequence").addEventListener("click", () => {
	void playFirstReleaseSequence();
});

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-model]")) {
	button.addEventListener("click", () => {
		const id = button.dataset.model ?? "whale";
		renderer.setModel(id);
		for (const peer of document.querySelectorAll("[data-model]")) {
			peer.classList.toggle("active", peer === button);
		}
		eventLog.textContent = `切换模型 · ${renderer.getModel().label}`;
	});
}

renderCategoryTabs();
renderActionList();
selectActionDisplay("enter");

window.addEventListener("beforeunload", () => {
	sequenceToken += 1;
	renderer.dispose();
});
