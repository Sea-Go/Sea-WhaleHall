import { useState } from "react";
import { MOCK_PET_PLAN, PetPlanPanel } from "./PetPlanPanel";
import { isPetPlanPanelEnabled } from "./plan-panel-flag";

/**
 * Dev-gated mount slot for the pet plan panel, rendered beside the
 * cloud-search card inside `.pet-stage` and reusing the panel's existing
 * bubble container styles. The switch (localStorage `sea.pet.planPanel=1`
 * with a `?petPlanPanel=1` URL override) is read once per mount — reload
 * the pet window to apply a change — and defaults to OFF so production
 * behavior is untouched. While the RTW task-domain endpoints have not
 * landed (see MOCK_PET_PLAN), the enabled panel renders the mock payload
 * and check-ins stay local (memory-only), with no port to wire yet.
 */
export function PetPlanPanelSlot() {
	const [enabled] = useState(isPetPlanPanelEnabled);
	if (!enabled) return null;
	return <PetPlanPanel plan={MOCK_PET_PLAN} />;
}
