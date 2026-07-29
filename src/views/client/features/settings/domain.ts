export const SETTINGS_CATEGORY_IDS = [
	"account",
	"appearance",
	"pet",
	"notifications",
	"calendar",
	"privacy",
	"about",
] as const;

export type SettingsCategory = (typeof SETTINGS_CATEGORY_IDS)[number];

export const SETTINGS_CATEGORY_LABELS: Record<SettingsCategory, string> = {
	account: "账号",
	appearance: "外观",
	pet: "桌宠",
	notifications: "通知",
	calendar: "日历",
	privacy: "数据与隐私",
	about: "关于",
};

export const APPEARANCE_THEME_IDS = [
	"orange",
	"ocean",
	"whale-fall",
	"firefly",
] as const;

export type AppearanceTheme = (typeof APPEARANCE_THEME_IDS)[number];

export const APPEARANCE_THEME_LABELS: Record<AppearanceTheme, string> = {
	orange: "橘子",
	ocean: "海洋",
	"whale-fall": "海洋鲸落",
	firefly: "萤火虫",
};

export type InterfaceDensity = "comfortable" | "compact";
export type CalendarDefaultView = "day" | "week" | "month";
export type ActivityRetentionDays = 7 | 30 | 90;

export interface PreferenceValues {
	appearance: {
		theme: AppearanceTheme;
		density: InterfaceDensity;
		reduceMotion: boolean;
	};
	pet: {
		visible: boolean;
		reactionsEnabled: boolean;
	};
	notifications: {
		enabled: boolean;
		planReminders: boolean;
		weeklyReview: boolean;
	};
	calendar: {
		defaultView: CalendarDefaultView;
		showWeekends: boolean;
		startWeekOnMonday: boolean;
	};
	privacy: {
		activityInsights: boolean;
		browserInsights: boolean;
		retentionDays: ActivityRetentionDays;
	};
}

export interface PreferencesSnapshot {
	values: PreferenceValues;
	version: number;
	savedAtMs: number | null;
}

export function createDefaultPreferences(): PreferenceValues {
	return {
		appearance: {
			theme: "orange",
			density: "comfortable",
			reduceMotion: false,
		},
		pet: {
			visible: true,
			reactionsEnabled: true,
		},
		notifications: {
			enabled: true,
			planReminders: true,
			weeklyReview: true,
		},
		calendar: {
			defaultView: "week",
			showWeekends: true,
			startWeekOnMonday: true,
		},
		privacy: {
			activityInsights: true,
			browserInsights: false,
			retentionDays: 30,
		},
	};
}

export function clonePreferenceValues(
	preferences: PreferenceValues,
): PreferenceValues {
	return {
		appearance: { ...preferences.appearance },
		pet: { ...preferences.pet },
		notifications: { ...preferences.notifications },
		calendar: { ...preferences.calendar },
		privacy: { ...preferences.privacy },
	};
}

export function clonePreferencesSnapshot(
	snapshot: PreferencesSnapshot,
): PreferencesSnapshot {
	return {
		values: clonePreferenceValues(snapshot.values),
		version: snapshot.version,
		savedAtMs: snapshot.savedAtMs,
	};
}

export function preferenceValuesEqual(
	left: PreferenceValues,
	right: PreferenceValues,
): boolean {
	return (
		left.appearance.theme === right.appearance.theme &&
		left.appearance.density === right.appearance.density &&
		left.appearance.reduceMotion === right.appearance.reduceMotion &&
		left.pet.visible === right.pet.visible &&
		left.pet.reactionsEnabled === right.pet.reactionsEnabled &&
		left.notifications.enabled === right.notifications.enabled &&
		left.notifications.planReminders === right.notifications.planReminders &&
		left.notifications.weeklyReview === right.notifications.weeklyReview &&
		left.calendar.defaultView === right.calendar.defaultView &&
		left.calendar.showWeekends === right.calendar.showWeekends &&
		left.calendar.startWeekOnMonday === right.calendar.startWeekOnMonday &&
		left.privacy.activityInsights === right.privacy.activityInsights &&
		left.privacy.browserInsights === right.privacy.browserInsights &&
		left.privacy.retentionDays === right.privacy.retentionDays
	);
}

export function isPreferenceValues(value: unknown): value is PreferenceValues {
	return parsePreferenceValues(value, false) !== null;
}

export function isPreferencesSnapshot(
	value: unknown,
): value is PreferencesSnapshot {
	if (!isRecord(value)) return false;
	return (
		parsePreferenceValues(value.values, false) !== null &&
		isPreferencesSnapshotMetadata(value)
	);
}

/*
 * Legacy snapshots predate theme selection. Preserve every other preference
 * and migrate only the missing theme to the orange default.
 */
export function preferencesSnapshotFromUnknown(
	value: unknown,
): PreferencesSnapshot | null {
	if (!isRecord(value) || !isPreferencesSnapshotMetadata(value)) return null;
	const values = parsePreferenceValues(value.values, true);
	if (!values) return null;
	return {
		values,
		version: value.version,
		savedAtMs: value.savedAtMs,
	};
}

function parsePreferenceValues(
	value: unknown,
	allowLegacyTheme: boolean,
): PreferenceValues | null {
	if (!isRecord(value)) return null;
	const { appearance, pet, notifications, calendar, privacy } = value;
	if (
		!isRecord(appearance) ||
		!isRecord(pet) ||
		!isRecord(notifications) ||
		!isRecord(calendar) ||
		!isRecord(privacy)
	) {
		return null;
	}

	const theme =
		isAppearanceTheme(appearance.theme)
			? appearance.theme
			: allowLegacyTheme && appearance.theme === undefined
				? "orange"
				: null;
	if (
		theme === null ||
		!((appearance.density === "comfortable" ||
			appearance.density === "compact") &&
			typeof appearance.reduceMotion === "boolean" &&
			typeof pet.visible === "boolean" &&
			typeof pet.reactionsEnabled === "boolean" &&
			typeof notifications.enabled === "boolean" &&
			typeof notifications.planReminders === "boolean" &&
			typeof notifications.weeklyReview === "boolean" &&
			(calendar.defaultView === "day" ||
				calendar.defaultView === "week" ||
				calendar.defaultView === "month") &&
			typeof calendar.showWeekends === "boolean" &&
			typeof calendar.startWeekOnMonday === "boolean" &&
			typeof privacy.activityInsights === "boolean" &&
			typeof privacy.browserInsights === "boolean" &&
			(privacy.retentionDays === 7 ||
				privacy.retentionDays === 30 ||
				privacy.retentionDays === 90))
	) {
		return null;
	}

	return {
		appearance: {
			theme,
			density: appearance.density,
			reduceMotion: appearance.reduceMotion,
		},
		pet: {
			visible: pet.visible,
			reactionsEnabled: pet.reactionsEnabled,
		},
		notifications: {
			enabled: notifications.enabled,
			planReminders: notifications.planReminders,
			weeklyReview: notifications.weeklyReview,
		},
		calendar: {
			defaultView: calendar.defaultView,
			showWeekends: calendar.showWeekends,
			startWeekOnMonday: calendar.startWeekOnMonday,
		},
		privacy: {
			activityInsights: privacy.activityInsights,
			browserInsights: privacy.browserInsights,
			retentionDays: privacy.retentionDays,
		},
	};
}

function isAppearanceTheme(value: unknown): value is AppearanceTheme {
	return (
		value === "orange" ||
		value === "ocean" ||
		value === "whale-fall" ||
		value === "firefly"
	);
}

function isPreferencesSnapshotMetadata(
	value: Record<string, unknown>,
): value is Record<string, unknown> & {
	version: number;
	savedAtMs: number | null;
} {
	return (
		typeof value.version === "number" &&
		Number.isSafeInteger(value.version) &&
		value.version >= 0 &&
		(value.savedAtMs === null ||
			(typeof value.savedAtMs === "number" &&
				Number.isFinite(value.savedAtMs) &&
				value.savedAtMs >= 0))
	);
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
