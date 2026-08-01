export {
	PreferencesController,
	type PreferencesOperation,
	type PreferencesState,
} from "./PreferencesController";
export {
	AgentPermissionsController,
	type AgentPermissionsState,
} from "./AgentPermissionsController";
export {
	AgentPermissionsServiceError,
	type AgentPermissionsFailureKind,
	type AgentPermissionsService,
} from "./agent-permissions-service";
export type { PreferencesService } from "./preferences-service";
export {
	APPEARANCE_THEME_IDS,
	APPEARANCE_THEME_LABELS,
	SETTINGS_CATEGORY_IDS,
	SETTINGS_CATEGORY_LABELS,
	createDefaultPreferences,
	preferenceValuesEqual,
	type AppearanceTheme,
	type PreferenceValues,
	type PreferencesSnapshot,
	type SettingsCategory,
} from "./domain";
export { SettingsPage, type SettingsPageProps } from "./SettingsPage";
