import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({
	url: "http://whalehall-pet-plan-slot.test/",
	width: 360,
	height: 300,
});
const reactActEnvironment = globalThis as typeof globalThis & {
	IS_REACT_ACT_ENVIRONMENT?: boolean;
};
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const [
	{ cleanup, render },
	{ PetPlanPanelSlot },
	{ isPetPlanPanelEnabled, PET_PLAN_PANEL_STORAGE_KEY },
] = await Promise.all([
	import("@testing-library/react"),
	import("../src/views/pet/PetPlanPanelSlot"),
	import("../src/views/pet/plan-panel-flag"),
]);

afterEach(() => {
	window.localStorage.clear();
	cleanup();
});
afterAll(async () => {
	delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
	await GlobalRegistrator.unregister();
});

function storageStub(value: string | null): Pick<Storage, "getItem"> {
	return { getItem: () => value };
}

describe("plan panel dev switch (isPetPlanPanelEnabled)", () => {
	test('stays off without the flag and rejects non-"1" storage values', () => {
		expect(
			isPetPlanPanelEnabled({ storage: storageStub(null), search: "" }),
		).toBeFalse();
		expect(
			isPetPlanPanelEnabled({ storage: storageStub("0"), search: "" }),
		).toBeFalse();
		expect(
			isPetPlanPanelEnabled({ storage: storageStub("true"), search: "" }),
		).toBeFalse();
	});

	test("reads the sea.pet.planPanel localStorage key from the live window", () => {
		window.localStorage.setItem(PET_PLAN_PANEL_STORAGE_KEY, "1");
		expect(isPetPlanPanelEnabled()).toBeTrue();
		window.localStorage.setItem(PET_PLAN_PANEL_STORAGE_KEY, "0");
		expect(isPetPlanPanelEnabled()).toBeFalse();
	});

	test("the URL parameter overrides localStorage for that load", () => {
		expect(
			isPetPlanPanelEnabled({
				storage: storageStub("1"),
				search: "?petPlanPanel=1",
			}),
		).toBeTrue();
		expect(
			isPetPlanPanelEnabled({
				storage: storageStub("1"),
				search: "?petPlanPanel=0",
			}),
		).toBeFalse();
		expect(
			isPetPlanPanelEnabled({
				storage: storageStub(null),
				search: "?petPlanPanel=1",
			}),
		).toBeTrue();
	});
});

describe("PetPlanPanelSlot", () => {
	test("renders nothing while the switch is off (production default)", () => {
		const view = render(<PetPlanPanelSlot />);
		expect(view.container.querySelector(".pet-plan-panel")).toBeNull();
		expect(view.queryByLabelText("桌宠计划面板")).toBeNull();
	});

	test("mounts the plan panel with the mock payload when enabled", () => {
		window.localStorage.setItem(PET_PLAN_PANEL_STORAGE_KEY, "1");
		const view = render(<PetPlanPanelSlot />);
		const panel = view.getByLabelText("桌宠计划面板");
		expect(panel).toBeTruthy();
		// Mock payload stays visible until the RTW task-domain endpoint lands.
		expect(view.getByText("养成晨间阅读习惯")).toBeTruthy();
		expect(view.getByRole("button", { name: "完成" })).toBeTruthy();
	});
});
