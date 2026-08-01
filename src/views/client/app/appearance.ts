import type { PreferenceValues } from "../features/settings/public";

interface AppearanceDatasetTarget {
	dataset: {
		uiTheme?: string;
		uiDensity?: string;
		reduceMotion?: string;
	};
}

export function applyAppearancePreferences(
	appearance: PreferenceValues["appearance"],
	target: AppearanceDatasetTarget = document.documentElement,
): void {
	target.dataset.uiTheme = appearance.theme;
	target.dataset.uiDensity = appearance.density;
	target.dataset.reduceMotion = appearance.reduceMotion ? "true" : "false";
}
