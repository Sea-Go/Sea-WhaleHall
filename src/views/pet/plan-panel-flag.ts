/**
 * Dev switch for the pet plan panel mount. Default OFF so production pet
 * windows are untouched; plan data still has no RTW task-domain endpoint
 * (see MOCK_PET_PLAN in PetPlanPanel.tsx), so the panel renders mock
 * payloads and stays behind this flag until that lands.
 *
 * Precedent: browser-side flags in this repo ride plain web storage (see
 * MockPreferencesService / the localStorage note in SettingsPage). The
 * pet WebView URL is fixed by the Bun window controller, so the durable
 * switch is a localStorage key; the URL parameter is a per-load override
 * for browser/demo runs and wins over storage. The value is read once per
 * mount — reload the pet window to apply a change.
 */

/** localStorage key: set to "1" to show the pet plan panel. */
export const PET_PLAN_PANEL_STORAGE_KEY = "sea.pet.planPanel";

/** URL parameter override: `?petPlanPanel=1` (any other value disables). */
export const PET_PLAN_PANEL_URL_PARAM = "petPlanPanel";

export interface PetPlanPanelFlagLookup {
	/** Storage-like reader; defaults to the current window's localStorage. */
	storage?: Pick<Storage, "getItem">;
	/** Raw query string; defaults to the current window's location.search. */
	search?: string;
}

function defaultStorage(): Pick<Storage, "getItem"> | null {
	return typeof window === "undefined" ? null : window.localStorage;
}

function defaultSearch(): string {
	return typeof window === "undefined" ? "" : window.location.search;
}

export function isPetPlanPanelEnabled(
	lookup: PetPlanPanelFlagLookup = {},
): boolean {
	const storage = lookup.storage ?? defaultStorage();
	const search = lookup.search ?? defaultSearch();
	const override = new URLSearchParams(search).get(PET_PLAN_PANEL_URL_PARAM);
	if (override !== null) return override === "1";
	return storage?.getItem(PET_PLAN_PANEL_STORAGE_KEY) === "1";
}
