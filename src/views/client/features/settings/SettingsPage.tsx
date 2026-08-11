import {
	Bell,
	CalendarDays,
	Cat,
	Check,
	ChevronRight,
	CircleUserRound,
	Info,
	MonitorCog,
	RotateCcw,
	Save,
	ShieldCheck,
} from "lucide-react";
import {
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
	type KeyboardEvent,
	type ReactNode,
} from "react";
import type { AuthUser } from "../auth/public";
import {
	MonitoringExclusionsControl,
	MonitoringPermissionsControl,
	type MonitoringController,
} from "../monitoring/public";
import {
	AuditExportControl,
	type AuditExportService,
} from "../audit-export/public";
import {
	CloudSyncStatusControl,
	type CloudSyncController,
} from "./public";
import { Button } from "../../shared/ui/Button";
import { ConfirmationDialog } from "../../shared/ui/ConfirmationDialog";
import { EmptyState } from "../../shared/ui/EmptyState";
import { PageHeader } from "../../shared/ui/PageHeader";
import type { PreferencesController } from "./PreferencesController";
import {
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
import "./SettingsPage.css";

const categoryIcons = {
	account: CircleUserRound,
	appearance: MonitorCog,
	pet: Cat,
	notifications: Bell,
	calendar: CalendarDays,
	privacy: ShieldCheck,
	about: Info,
} as const;

const appearanceThemeDescriptions: Record<AppearanceTheme, string> = {
	orange: "奶油白与鲜橘暖光，像阳光落进清晨的果园。",
	observatory: "靛蓝星幕与星座微光，像安静的午夜天文馆。",
	firefly: "深林青绿与流动萤光，像夏夜溪谷里的呼吸。",
	"whale-fall": "深海蓝绿与鲸落微光，沉静、辽阔而富有生命。",
};

export interface SettingsPageProps {
	user: AuthUser;
	controller: PreferencesController;
	monitoringController: MonitoringController;
	cloudSyncController: CloudSyncController;
	auditExportService: AuditExportService;
	category: SettingsCategory;
	onCategoryChange: (category: SettingsCategory) => void;
	onLogout: () => void;
	onPreferencesApplied: (snapshot: PreferencesSnapshot) => void;
}

export function SettingsPage({
	user,
	controller,
	monitoringController,
	cloudSyncController,
	auditExportService,
	category,
	onCategoryChange,
	onLogout,
	onPreferencesApplied,
}: SettingsPageProps) {
	const state = useSyncExternalStore(
		controller.subscribe,
		controller.getSnapshot,
		controller.getServerSnapshot,
	);
	const categoryRefs = useRef<Array<HTMLButtonElement | null>>([]);
	const restoreButtonRef = useRef<HTMLButtonElement>(null);
	const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);
	const lastAppliedVersionRef = useRef<number | null>(null);

	useEffect(() => {
		if (state.status === "idle") void controller.load();
	}, [controller, state.status]);

	useEffect(() => {
		if (!("snapshot" in state)) return;
		if (lastAppliedVersionRef.current === state.snapshot.version) return;
		lastAppliedVersionRef.current = state.snapshot.version;
		onPreferencesApplied(state.snapshot);
	}, [onPreferencesApplied, state]);

	function handleCategoryKeyDown(
		event: KeyboardEvent<HTMLButtonElement>,
		index: number,
	) {
		if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
		event.preventDefault();
		const nextIndex =
			event.key === "Home"
				? 0
				: event.key === "End"
					? SETTINGS_CATEGORY_IDS.length - 1
					: event.key === "ArrowDown"
						? (index + 1) % SETTINGS_CATEGORY_IDS.length
						: (index - 1 + SETTINGS_CATEGORY_IDS.length) %
							SETTINGS_CATEGORY_IDS.length;
		const nextCategory = SETTINGS_CATEGORY_IDS[nextIndex];
		if (!nextCategory) return;
		onCategoryChange(nextCategory);
		window.requestAnimationFrame(() => categoryRefs.current[nextIndex]?.focus());
	}

	const hasPreferences = "snapshot" in state;
	const saving = state.status === "saving";
	const preferencesState = hasPreferences ? state : null;
	const defaultPreferences = createDefaultPreferences();
	const canRestoreDefaults =
		preferencesState !== null &&
		(!preferenceValuesEqual(
			preferencesState.snapshot.values,
			defaultPreferences,
		) ||
			!preferenceValuesEqual(preferencesState.draft, defaultPreferences));

	return (
		<div className="settings-page">
			<PageHeader
				eyebrow="个人偏好"
				title="设置"
				description="控制 WhaleHall 的界面、桌宠反馈和本地数据偏好。所有选择先保存在这台设备。"
			/>

			<div className="settings-workspace">
				<nav className="settings-categories" aria-label="设置分类">
					{SETTINGS_CATEGORY_IDS.map((item, index) => {
						const Icon = categoryIcons[item];
						const active = item === category;
						return (
							<button
								key={item}
								ref={(node) => {
									categoryRefs.current[index] = node;
								}}
								type="button"
								aria-current={active ? "page" : undefined}
								tabIndex={active ? 0 : -1}
								onClick={() => onCategoryChange(item)}
								onKeyDown={(event) => handleCategoryKeyDown(event, index)}
							>
								<Icon size={17} aria-hidden="true" />
								<span>{SETTINGS_CATEGORY_LABELS[item]}</span>
								{active ? <ChevronRight size={15} aria-hidden="true" /> : null}
							</button>
						);
					})}
				</nav>

				<section
					className="settings-content"
					aria-label={`${SETTINGS_CATEGORY_LABELS[category]}设置`}
					aria-busy={state.status === "loading" || saving}
				>
					{state.status === "loading" || state.status === "idle" ? (
						<SettingsLoading />
					) : null}

					{state.status === "error" && state.stage === "load" ? (
						<div className="settings-load-state">
							<EmptyState
								icon={<ShieldCheck size={21} />}
								eyebrow="设置未载入"
								title="暂时无法读取本机设置"
								description={state.message}
								action={
									<Button onClick={() => void controller.load()}>
										重新读取
									</Button>
								}
							/>
						</div>
					) : null}

					{preferencesState ? (
						<>
							<div className="settings-content__scroll">
								<SettingsStatus state={state} />
								<SettingsPanel
									category={category}
									user={user}
									values={preferencesState.draft}
									disabled={saving}
									monitoringController={monitoringController}
									cloudSyncController={cloudSyncController}
									auditExportService={auditExportService}
									onUpdate={(section, value) =>
										controller.update(section, value)
									}
									onLogout={onLogout}
								/>
							</div>
							<footer className="settings-savebar">
								<div>
									<strong>
										{preferencesState.dirty
											? "有未保存的更改"
											: "所有更改已保存"}
									</strong>
									<span>
										{preferencesState.dirty
											? "保存失败时会自动恢复到上次保存的内容。"
											: formatSavedAt(preferencesState.snapshot.savedAtMs)}
									</span>
								</div>
								<div>
									<Button
										ref={restoreButtonRef}
										variant="ghost"
										icon={<RotateCcw size={15} aria-hidden="true" />}
										disabled={saving || !canRestoreDefaults}
										onClick={() => setRestoreDialogOpen(true)}
									>
										恢复默认
									</Button>
									<Button
										variant="primary"
										icon={<Save size={15} aria-hidden="true" />}
										disabled={!preferencesState.dirty || saving}
										onClick={() => void controller.save()}
									>
										{saving && state.operation === "save"
											? "正在保存…"
											: "保存更改"}
									</Button>
								</div>
							</footer>
						</>
					) : null}
				</section>
			</div>

			{restoreDialogOpen ? (
				<ConfirmationDialog
					title="恢复所有默认设置？"
					description="外观、桌宠、通知、日历和隐私偏好都会恢复默认值。账号和已创建的计划、日程不会被删除。"
					confirmLabel="恢复默认"
					busy={saving && state.operation === "restore-defaults"}
					onCancel={() => setRestoreDialogOpen(false)}
					onConfirm={() => {
						void controller.restoreDefaults().then(() => {
							setRestoreDialogOpen(false);
						});
					}}
					returnFocusRef={restoreButtonRef}
				/>
			) : null}
		</div>
	);
}

function SettingsStatus({
	state,
}: {
	state: ReturnType<PreferencesController["getSnapshot"]>;
}) {
	if (state.status === "saving") {
		return (
			<div className="settings-status settings-status--saving" role="status">
				<span className="settings-status__dot" aria-hidden="true" />
				{state.operation === "restore-defaults"
					? "正在恢复默认设置…"
					: "正在保存到本机…"}
			</div>
		);
	}
	if (state.status === "success") {
		return (
			<div className="settings-status settings-status--success" role="status">
				{state.message}
			</div>
		);
	}
	if (state.status === "error" && state.stage !== "load") {
		return (
			<div className="settings-status settings-status--error" role="alert">
				{state.message}
			</div>
		);
	}
	return null;
}

interface SettingsPanelProps {
	category: SettingsCategory;
	user: AuthUser;
	values: PreferenceValues;
	disabled: boolean;
	monitoringController: MonitoringController;
	cloudSyncController: CloudSyncController;
	auditExportService: AuditExportService;
	onUpdate: <K extends keyof PreferenceValues>(
		section: K,
		value: PreferenceValues[K],
	) => void;
	onLogout: () => void;
}

function SettingsPanel(props: SettingsPanelProps) {
	switch (props.category) {
		case "account":
			return <AccountSettings user={props.user} onLogout={props.onLogout} />;
		case "appearance":
			return <AppearanceSettings {...props} />;
		case "pet":
			return <PetSettings {...props} />;
		case "notifications":
			return <NotificationSettings {...props} />;
		case "calendar":
			return <CalendarSettings {...props} />;
		case "privacy":
			return <PrivacySettings {...props} />;
		case "about":
			return <AboutSettings />;
	}
}

function AccountSettings({
	user,
	onLogout,
}: {
	user: AuthUser;
	onLogout: () => void;
}) {
	return (
		<SettingsSection
			eyebrow="账号"
			title="你的 WhaleHall"
			description="当前体验环境只保存 UI 会话，不在渲染进程中保存 refresh token。"
		>
			<div className="settings-account-card">
				<span aria-hidden="true">{user.initials}</span>
				<div>
					<strong>{user.displayName}</strong>
					<small>{user.email}</small>
				</div>
				<span className="settings-badge settings-badge--success">
					已登录 · 本地就绪
				</span>
			</div>
			<SettingRow
				title="退出当前账号"
				description="退出后会立即清理受保护的 UI 会话并返回登录门禁。"
				control={
					<Button variant="danger" onClick={onLogout}>
						退出登录
					</Button>
				}
			/>
		</SettingsSection>
	);
}

function AppearanceSettings({
	values,
	disabled,
	onUpdate,
}: SettingsPanelProps) {
	return (
		<SettingsSection
			eyebrow="外观"
			title="主题、界面与动效"
			description="选择适合此刻的氛围。主题会立即预览，保存后在下次启动继续使用。"
		>
			<ThemePicker
				value={values.appearance.theme}
				disabled={disabled}
				onChange={(theme) =>
					onUpdate("appearance", {
						...values.appearance,
						theme,
					})
				}
			/>
			<SettingRow
				title="颜色模式"
				description="橘子主题使用柔和浅色，其余主题使用低亮度深色；文字与控件保持清晰对比。"
				control={
					<span className="settings-badge">
						{values.appearance.theme === "orange" ? "柔和浅色" : "沉浸深色"}
					</span>
				}
			/>
			<SettingRow
				title="界面密度"
				description="紧凑模式会减少设置和导航的垂直留白，不隐藏内容。"
				control={
					<label className="settings-select">
						<span className="sr-only">界面密度</span>
						<select
							value={values.appearance.density}
							disabled={disabled}
							onChange={(event) =>
								onUpdate("appearance", {
									...values.appearance,
									density:
										event.currentTarget.value === "compact"
											? "compact"
											: "comfortable",
								})
							}
						>
							<option value="comfortable">舒适</option>
							<option value="compact">紧凑</option>
						</select>
					</label>
				}
			/>
			<SettingRow
				title="减少动态效果"
				description="减少非必要位移动画；状态变化和操作反馈仍保持可见。"
				control={
					<SwitchControl
						label="减少动态效果"
						checked={values.appearance.reduceMotion}
						disabled={disabled}
						onChange={(checked) =>
							onUpdate("appearance", {
								...values.appearance,
								reduceMotion: checked,
							})
						}
					/>
				}
			/>
		</SettingsSection>
	);
}

function ThemePicker({
	value,
	disabled,
	onChange,
}: {
	value: AppearanceTheme;
	disabled: boolean;
	onChange: (theme: AppearanceTheme) => void;
}) {
	return (
		<fieldset className="settings-theme-picker">
			<legend>界面主题</legend>
			<p>背景、侧栏、卡片和强调色会一起切换。</p>
			<div className="settings-theme-grid">
				{APPEARANCE_THEME_IDS.map((theme) => {
					const selected = theme === value;
					return (
						<label
							className="settings-theme-card"
							data-theme-option={theme}
							key={theme}
						>
							<input
								type="radio"
								name="appearance-theme"
								value={theme}
								checked={selected}
								disabled={disabled}
								onChange={() => onChange(theme)}
							/>
							<span className="settings-theme-card__preview" aria-hidden="true">
								<span className="settings-theme-card__sidebar" />
								<span className="settings-theme-card__content">
									<i />
									<i />
									<i />
								</span>
								<span className="settings-theme-card__glow" />
							</span>
							<span className="settings-theme-card__copy">
								<strong>{APPEARANCE_THEME_LABELS[theme]}</strong>
								<small>{appearanceThemeDescriptions[theme]}</small>
							</span>
							<span className="settings-theme-card__state">
								{selected ? <Check size={13} aria-hidden="true" /> : null}
								{selected ? "已选择" : "选择"}
							</span>
						</label>
					);
				})}
			</div>
		</fieldset>
	);
}

function PetSettings({ values, disabled, onUpdate }: SettingsPanelProps) {
	return (
		<SettingsSection
			eyebrow="桌宠"
			title="陪伴与反馈"
			description="桌宠只接收无敏感内容的表现事件，不读取登录凭据、计划标题或活动明细。"
		>
			<SettingRow
				title="显示桌宠"
				description="控制独立桌宠窗口的可见性，不影响计划、日历或报告。"
				control={
					<SwitchControl
						label="显示桌宠"
						checked={values.pet.visible}
						disabled={disabled}
						onChange={(checked) =>
							onUpdate("pet", { ...values.pet, visible: checked })
						}
					/>
				}
			/>
			<SettingRow
				title="跟随工作状态反馈"
				description="计划生成和长时间无互动时，允许桌宠播放简短的表现动作。"
				control={
					<SwitchControl
						label="跟随工作状态反馈"
						checked={values.pet.reactionsEnabled}
						disabled={disabled || !values.pet.visible}
						onChange={(checked) =>
							onUpdate("pet", {
								...values.pet,
								reactionsEnabled: checked,
							})
						}
					/>
				}
			/>
			<div className="settings-privacy-note">
				<ShieldCheck size={16} aria-hidden="true" />
				<span>表现事件发送失败时会静默降级，不会打断核心工作流。</span>
			</div>
		</SettingsSection>
	);
}

function NotificationSettings({
	values,
	disabled,
	onUpdate,
}: SettingsPanelProps) {
	const section = values.notifications;
	return (
		<SettingsSection
			eyebrow="通知"
			title="提醒节奏"
			description="这些本地偏好为后续系统通知 adapter 保留明确边界。"
		>
			<SettingRow
				title="允许通知"
				description="关闭后，计划提醒和回顾提醒都会暂停。"
				control={
					<SwitchControl
						label="允许通知"
						checked={section.enabled}
						disabled={disabled}
						onChange={(checked) =>
							onUpdate("notifications", { ...section, enabled: checked })
						}
					/>
				}
			/>
			<SettingRow
				title="计划开始提醒"
				description="在已确认的计划日程开始前提醒。"
				control={
					<SwitchControl
						label="计划开始提醒"
						checked={section.planReminders}
						disabled={disabled || !section.enabled}
						onChange={(checked) =>
							onUpdate("notifications", {
								...section,
								planReminders: checked,
							})
						}
					/>
				}
			/>
			<SettingRow
				title="每周回顾提醒"
				description="每周结束前提醒查看成长报告。"
				control={
					<SwitchControl
						label="每周回顾提醒"
						checked={section.weeklyReview}
						disabled={disabled || !section.enabled}
						onChange={(checked) =>
							onUpdate("notifications", {
								...section,
								weeklyReview: checked,
							})
						}
					/>
				}
			/>
		</SettingsSection>
	);
}

function CalendarSettings({
	values,
	disabled,
	onUpdate,
}: SettingsPanelProps) {
	const section = values.calendar;
	return (
		<SettingsSection
			eyebrow="日历"
			title="默认日历体验"
			description="更改只影响打开日历时的默认表现，不修改已有日程。"
		>
			<SettingRow
				title="默认视图"
				description="选择进入日历时最先显示的时间范围。"
				control={
					<label className="settings-select">
						<span className="sr-only">默认日历视图</span>
						<select
							value={section.defaultView}
							disabled={disabled}
							onChange={(event) => {
								const value = event.currentTarget.value;
								const defaultView =
									value === "day" || value === "month" ? value : "week";
								onUpdate("calendar", { ...section, defaultView });
							}}
						>
							<option value="day">日视图</option>
							<option value="week">周视图</option>
							<option value="month">月视图</option>
						</select>
					</label>
				}
			/>
			<SettingRow
				title="显示周末"
				description="周视图和月视图保留周六、周日。"
				control={
					<SwitchControl
						label="显示周末"
						checked={section.showWeekends}
						disabled={disabled}
						onChange={(checked) =>
							onUpdate("calendar", { ...section, showWeekends: checked })
						}
					/>
				}
			/>
			<SettingRow
				title="每周从周一开始"
				description="关闭后每周从周日开始；日期本身不会改变。"
				control={
					<SwitchControl
						label="每周从周一开始"
						checked={section.startWeekOnMonday}
						disabled={disabled}
						onChange={(checked) =>
							onUpdate("calendar", {
								...section,
								startWeekOnMonday: checked,
							})
						}
					/>
				}
			/>
		</SettingsSection>
	);
}

function PrivacySettings({
	values,
	disabled,
	onUpdate,
	monitoringController,
	cloudSyncController,
	auditExportService,
}: SettingsPanelProps) {
	const section = values.privacy;
	return (
		<SettingsSection
			eyebrow="数据与隐私"
			title="本地数据边界"
			description="通过唯一入口完成一次性监测设置；macOS 拆分的必需权限会集中显示，完成后不再重复请求。"
		>
			<AuditExportControl service={auditExportService} />
			<MonitoringPermissionsControl controller={monitoringController} />
			<MonitoringExclusionsControl controller={monitoringController} />
			<CloudSyncStatusControl controller={cloudSyncController} />
			<SettingRow
				title="使用活动汇总生成洞察"
				description="只使用本地聚合时长，不把窗口内容发送到桌宠。"
				control={
					<SwitchControl
						label="使用活动汇总生成洞察"
						checked={section.activityInsights}
						disabled={disabled}
						onChange={(checked) =>
							onUpdate("privacy", {
								...section,
								activityInsights: checked,
							})
						}
					/>
				}
			/>
			<SettingRow
				title="使用浏览器分类汇总"
				description="默认关闭；启用偏好不等于授予系统读取权限。"
				control={
					<SwitchControl
						label="使用浏览器分类汇总"
						checked={section.browserInsights}
						disabled={disabled}
						onChange={(checked) =>
							onUpdate("privacy", {
								...section,
								browserInsights: checked,
							})
						}
					/>
				}
			/>
			<SettingRow
				title="活动汇总保留周期"
				description="用于未来的数据 adapter；原始记录清理由明确的本地工具单独确认。"
				control={
					<label className="settings-select">
						<span className="sr-only">活动汇总保留周期</span>
						<select
							value={section.retentionDays}
							disabled={disabled}
							onChange={(event) => {
								const value = Number(event.currentTarget.value);
								const retentionDays =
									value === 7 || value === 90 ? value : 30;
								onUpdate("privacy", { ...section, retentionDays });
							}}
						>
							<option value={7}>7 天</option>
							<option value={30}>30 天</option>
							<option value={90}>90 天</option>
						</select>
					</label>
				}
			/>
			<div className="settings-privacy-note">
				<ShieldCheck size={16} aria-hidden="true" />
				<span>
					认证信息、完整网址、搜索词和输入内容不会进入设置存储或桌宠日志。
				</span>
			</div>
		</SettingsSection>
	);
}

function AboutSettings() {
	return (
		<SettingsSection
			eyebrow="关于"
			title="WhaleHall"
			description="A whale falls, and myriad creatures flourish."
		>
			<SettingRow
				title="版本"
				description="当前本地体验构建。"
				control={<span className="settings-value">0.1.0</span>}
			/>
			<SettingRow
				title="运行边界"
				description="React 客户端、Typed RPC、Bun 主进程和 Rust Local Tool Host 保持独立。"
				control={<span className="settings-badge">本地优先</span>}
			/>
			<div className="settings-about-copy">
				<strong>把时间留给重要的事。</strong>
				<p>
					WhaleHall 帮助你制定计划、安排时间并诚实回顾投入。数据能力默认留在本机边界内。
				</p>
			</div>
		</SettingsSection>
	);
}

function SettingsSection({
	eyebrow,
	title,
	description,
	children,
}: {
	eyebrow: string;
	title: string;
	description: string;
	children: ReactNode;
}) {
	return (
		<div className="settings-panel">
			<header>
				<span>{eyebrow}</span>
				<h2>{title}</h2>
				<p>{description}</p>
			</header>
			<div className="settings-rows">{children}</div>
		</div>
	);
}

function SettingRow({
	title,
	description,
	control,
}: {
	title: string;
	description: string;
	control: ReactNode;
}) {
	return (
		<div className="settings-row">
			<div>
				<strong>{title}</strong>
				<p>{description}</p>
			</div>
			<div className="settings-row__control">{control}</div>
		</div>
	);
}

function SwitchControl({
	label,
	checked,
	disabled,
	onChange,
}: {
	label: string;
	checked: boolean;
	disabled: boolean;
	onChange: (checked: boolean) => void;
}) {
	return (
		<button
			className="settings-switch"
			type="button"
			role="switch"
			aria-label={label}
			aria-checked={checked}
			disabled={disabled}
			onClick={() => onChange(!checked)}
		>
			<span aria-hidden="true" />
		</button>
	);
}

function SettingsLoading() {
	return (
		<div className="settings-loading" role="status">
			<span className="settings-loading__mark" aria-hidden="true" />
			<div>
				<strong>正在读取本机设置</strong>
				<p>确认已保存的界面、桌宠和隐私偏好。</p>
			</div>
		</div>
	);
}

function formatSavedAt(savedAtMs: number | null): string {
	if (savedAtMs === null) return "当前使用默认设置，尚未写入本机。";
	return `最近保存于 ${new Intl.DateTimeFormat("zh-CN", {
		hour: "2-digit",
		minute: "2-digit",
	}).format(savedAtMs)}`;
}
