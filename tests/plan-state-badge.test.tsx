import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({
	url: "http://whalehall-pet-plan-badge.test/",
	width: 360,
	height: 300,
});
const reactActEnvironment = globalThis as typeof globalThis & {
	IS_REACT_ACT_ENVIRONMENT?: boolean;
};
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const [
	{ cleanup, render },
	{ PlanStateBadge },
	{ PLAN_LIFECYCLE_META, PLAN_LIFECYCLE_STATUSES },
] = await Promise.all([
	import("@testing-library/react"),
	import("../src/views/pet/PlanStateBadge"),
	import("../src/views/pet/plan-lifecycle"),
]);

afterEach(() => cleanup());
afterAll(async () => {
	delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
	await GlobalRegistrator.unregister();
});

describe("PlanStateBadge", () => {
	test("renders every lifecycle state with its label and status marker", () => {
		for (const status of PLAN_LIFECYCLE_STATUSES) {
			const view = render(<PlanStateBadge status={status} />);
			const badge = view.getByText(PLAN_LIFECYCLE_META[status].label);
			expect(badge.getAttribute("data-status")).toBe(status);
			expect(badge.className).toContain(`pet-plan-badge--${status}`);
			cleanup();
		}
	});

	test("carries the state-machine meaning as the badge tooltip", () => {
		const view = render(<PlanStateBadge status="review" />);
		expect(view.getByText("复盘").getAttribute("title")).toBe(
			PLAN_LIFECYCLE_META.review.description,
		);
	});
});
