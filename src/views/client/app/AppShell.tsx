import {
	CalendarDays,
	Cat,
	ChartNoAxesCombined,
	ChevronUp,
	History,
	Info,
	LogOut,
	MessageCircle,
	Palette,
	Settings,
	ShieldCheck,
	Target,
	UserRound,
	Waves,
} from "lucide-react";
import type { KeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import {
	AppUpdateAttentionMark,
	type AppUpdateController,
} from "../features/app-update/public";
import type { AuditExportService } from "../features/audit-export/public";
import type { AuthUser } from "../features/auth/public";
import {
	CalendarController,
	CalendarPage,
	type CalendarService,
} from "../features/calendar/public";
import {
	type ConversationController,
	ConversationPage,
} from "../features/conversation/public";
import {
	type MonitoringController,
	MonitoringStatusControl,
} from "../features/monitoring/public";
import type { PetPresentationBridge } from "../features/pet-bridge/public";
import {
	type PlanningController,
	PlanningPage,
} from "../features/planning/public";
import {
	type ProactiveFeedbackHistoryController,
	ProactiveFeedbackHistoryPage,
	type ProactiveFeedbackPolicyController,
} from "../features/proactive-feedback/public";
import { type ReportController, ReportsPage } from "../features/reports/public";
import {
	type AgentPermissionsController,
	type PreferencesController,
	type PreferencesSnapshot,
	type SettingsCategory,
	SettingsPage,
} from "../features/settings/public";
import { ConfirmationDialog } from "../shared/ui/ConfirmationDialog";
import { applyAppearancePreferences } from "./appearance";
import { PAGE_LABELS, type PageId } from "./navigation";
import { PlanningPetCoordinator } from "./PlanningPetCoordinator";
import { PlanningSchedulePreview } from "./PlanningSchedulePreview";

type MenuAction =
	| "account"
	| "appearance"
	| "pet"
	| "privacy"
	| "about"
	| "logout";

const navigationItems = [
	{
		id: "conversation",
		label: PAGE_LABELS.conversation,
		icon: MessageCircle,
		disabled: false,
	},
	{
		id: "planning",
		label: PAGE_LABELS.planning,
		icon: Target,
		disabled: false,
	},
	{
		id: "calendar",
		label: PAGE_LABELS.calendar,
		icon: CalendarDays,
		disabled: false,
	},
	{ id: "history", label: PAGE_LABELS.history, icon: History, disabled: false },
	{
		id: "reports",
		label: PAGE_LABELS.reports,
		icon: ChartNoAxesCombined,
		disabled: false,
	},
] as const satisfies ReadonlyArray<{
	id: PageId;
	label: string;
	icon: typeof Target;
	disabled: boolean;
}>;

const userMenuItems = [
	{ id: "account", label: "账号设置", icon: UserRound },
	{ id: "appearance", label: "外观", icon: Palette },
	{ id: "pet", label: "桌宠设置", icon: Cat },
	{ id: "privacy", label: "数据与隐私", icon: ShieldCheck },
	{ id: "about", label: "关于与更新", icon: Info },
] as const satisfies ReadonlyArray<{
	id: Exclude<MenuAction, "logout">;
	label: string;
	icon: typeof UserRound;
}>;

export interface AppShellProps {
	user: AuthUser;
	onLogout: () => void;
	calendarService: CalendarService;
	calendarController?: CalendarController;
	conversationController: ConversationController;
	planningController: PlanningController;
	reportController: ReportController;
	preferencesController: PreferencesController;
	agentPermissionsController?: AgentPermissionsController;
	petBridge: PetPresentationBridge;
	monitoringController: MonitoringController;
	auditExportService: AuditExportService;
	proactiveFeedbackHistoryController: ProactiveFeedbackHistoryController;
	proactiveFeedbackPolicyController?: ProactiveFeedbackPolicyController;
	appUpdateController?: AppUpdateController;
	initialPage?: PageId;
	enableQaControls?: boolean;
}

export function AppShell({
	user,
	onLogout,
	calendarService,
	calendarController,
	conversationController,
	planningController,
	reportController,
	preferencesController,
	agentPermissionsController,
	petBridge,
	monitoringController,
	auditExportService,
	proactiveFeedbackHistoryController,
	proactiveFeedbackPolicyController,
	appUpdateController,
	initialPage = "calendar",
	enableQaControls = false,
}: AppShellProps) {
	const [activePage, setActivePage] = useState<PageId>(initialPage);
	const [settingsCategory, setSettingsCategory] =
		useState<SettingsCategory>("account");
	const [userMenuOpen, setUserMenuOpen] = useState(false);
	const [logoutDialogOpen, setLogoutDialogOpen] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const userMenuContainerRef = useRef<HTMLDivElement>(null);
	const userMenuRef = useRef<HTMLDivElement>(null);
	const userMenuTriggerRef = useRef<HTMLButtonElement>(null);
	const petReactionsEnabledRef = useRef(true);
	const planningPetCoordinator = useMemo(
		() => new PlanningPetCoordinator(planningController, petBridge),
		[petBridge, planningController],
	);
	const resolvedCalendarController = useMemo(
		() => calendarController ?? new CalendarController(calendarService),
		[calendarController, calendarService],
	);

	useEffect(() => {
		planningPetCoordinator.start();
		return () => planningPetCoordinator.stop();
	}, [planningPetCoordinator]);

	useEffect(() => {
		const inactiveAfterMs = 10 * 60 * 1_000;
		let timer: number | null = null;

		function scheduleInactivePresentation() {
			if (timer !== null) window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				timer = null;
				if (!petReactionsEnabledRef.current) return;
				void petBridge.present({ kind: "user-inactive" });
			}, inactiveAfterMs);
		}

		function handleActivity() {
			scheduleInactivePresentation();
		}

		document.addEventListener("keydown", handleActivity);
		document.addEventListener("pointerdown", handleActivity);
		scheduleInactivePresentation();
		return () => {
			if (timer !== null) window.clearTimeout(timer);
			document.removeEventListener("keydown", handleActivity);
			document.removeEventListener("pointerdown", handleActivity);
		};
	}, [petBridge]);

	useEffect(() => {
		if (!userMenuOpen) return;
		const animationFrame = window.requestAnimationFrame(() => {
			userMenuRef.current
				?.querySelector<HTMLButtonElement>('[role="menuitem"]')
				?.focus();
		});
		return () => window.cancelAnimationFrame(animationFrame);
	}, [userMenuOpen]);

	useEffect(() => {
		if (!userMenuOpen) return;

		function handleOutsidePointer(event: PointerEvent) {
			if (
				event.target instanceof Node &&
				!userMenuContainerRef.current?.contains(event.target)
			) {
				setUserMenuOpen(false);
			}
		}

		document.addEventListener("pointerdown", handleOutsidePointer);
		return () =>
			document.removeEventListener("pointerdown", handleOutsidePointer);
	}, [userMenuOpen]);

	useEffect(() => {
		if (!notice) return;
		const timer = window.setTimeout(() => setNotice(null), 3_600);
		return () => window.clearTimeout(timer);
	}, [notice]);

	function showNotice(message: string) {
		setNotice(message);
	}

	function closeUserMenu(returnFocus = true) {
		setUserMenuOpen(false);
		if (returnFocus) {
			window.requestAnimationFrame(() => userMenuTriggerRef.current?.focus());
		}
	}

	function selectMenuAction(action: MenuAction) {
		closeUserMenu(false);
		if (action === "logout") {
			setLogoutDialogOpen(true);
			return;
		}
		setSettingsCategory(action);
		setActivePage("settings");
	}

	const handlePreferencesApplied = useCallback(
		(snapshot: PreferencesSnapshot) => {
			applyAppearancePreferences(snapshot.values.appearance);
			petReactionsEnabledRef.current = snapshot.values.pet.reactionsEnabled;
			planningPetCoordinator.setEnabled(snapshot.values.pet.reactionsEnabled);
		},
		[planningPetCoordinator],
	);

	function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		const menuItems = Array.from(
			userMenuRef.current?.querySelectorAll<HTMLButtonElement>(
				'[role="menuitem"]',
			) ?? [],
		);
		if (menuItems.length === 0) return;

		if (event.key === "Escape") {
			event.preventDefault();
			closeUserMenu();
			return;
		}

		if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
		event.preventDefault();
		const activeElement = document.activeElement;
		const currentIndex =
			activeElement instanceof HTMLButtonElement
				? menuItems.indexOf(activeElement)
				: -1;
		const nextIndex =
			event.key === "Home"
				? 0
				: event.key === "End"
					? menuItems.length - 1
					: event.key === "ArrowDown"
						? (currentIndex + 1) % menuItems.length
						: (currentIndex - 1 + menuItems.length) % menuItems.length;
		menuItems[nextIndex]?.focus();
	}

	function handleNavigationClick(
		event: ReactMouseEvent<HTMLButtonElement>,
		page: PageId,
	) {
		if (event.currentTarget.disabled) return;
		setActivePage(page);
	}

	return (
		<div className="app-shell">
			<aside className="app-sidebar" aria-label="WhaleHall 主导航">
				<div className="app-sidebar__ambient" aria-hidden="true" />
				<div className="brand">
					<span className="brand__mark" aria-hidden="true">
						<Waves size={19} strokeWidth={2.1} />
					</span>
					<span className="brand__copy">
						<strong>WhaleHall</strong>
						<small>把时间留给重要的事</small>
					</span>
				</div>

				<nav className="primary-navigation" aria-label="工作空间">
					<p className="primary-navigation__label">工作空间</p>
					{navigationItems.map((item) => {
						const Icon = item.icon;
						const active = item.id === activePage;
						return (
							<button
								className="primary-navigation__item"
								type="button"
								key={item.id}
								disabled={item.disabled}
								aria-current={active ? "page" : undefined}
								onClick={(event) => handleNavigationClick(event, item.id)}
							>
								<Icon size={18} strokeWidth={1.9} aria-hidden="true" />
								<span>{item.label}</span>
								{active ? (
									<span className="primary-navigation__active-dot" />
								) : null}
							</button>
						);
					})}
				</nav>

				<MonitoringStatusControl
					controller={monitoringController}
					onOpenPrivacy={() => {
						setSettingsCategory("privacy");
						setActivePage("settings");
					}}
				/>

				<div className="user-entry" ref={userMenuContainerRef}>
					{userMenuOpen ? (
						<div
							className="user-menu"
							ref={userMenuRef}
							role="menu"
							aria-label="用户菜单"
							onKeyDown={handleMenuKeyDown}
						>
							<div className="user-menu__header">
								<span
									className="user-avatar user-avatar--small"
									aria-hidden="true"
								>
									{user.initials}
								</span>
								<div>
									<strong>{user.displayName}</strong>
									<small>{user.email}</small>
								</div>
							</div>
							<div className="user-menu__items">
								{userMenuItems.map((item) => {
									const Icon = item.icon;
									return (
										<button
											type="button"
											role="menuitem"
											tabIndex={-1}
											key={item.id}
											onClick={() => selectMenuAction(item.id)}
										>
											<Icon size={16} aria-hidden="true" />
											<span>{item.label}</span>
											{item.id === "about" && appUpdateController ? (
												<AppUpdateAttentionMark
													controller={appUpdateController}
												/>
											) : null}
										</button>
									);
								})}
							</div>
							<div className="user-menu__separator" />
							<button
								className="user-menu__logout"
								type="button"
								role="menuitem"
								tabIndex={-1}
								onClick={() => selectMenuAction("logout")}
							>
								<LogOut size={16} aria-hidden="true" />
								<span>退出登录</span>
							</button>
						</div>
					) : null}

					<button
						className="user-entry__trigger"
						ref={userMenuTriggerRef}
						type="button"
						aria-haspopup="menu"
						aria-expanded={userMenuOpen}
						onClick={() => setUserMenuOpen((current) => !current)}
					>
						<span className="user-avatar" aria-hidden="true">
							{user.initials}
						</span>
						<span className="user-entry__copy">
							<strong>{user.displayName}</strong>
							<small>已登录 · 本地就绪</small>
						</span>
						<span className="user-entry__status">
							{appUpdateController ? (
								<AppUpdateAttentionMark controller={appUpdateController} />
							) : null}
							<ChevronUp
								className={
									userMenuOpen ? "user-entry__chevron--open" : undefined
								}
								size={17}
								aria-hidden="true"
							/>
						</span>
					</button>
				</div>
			</aside>

			<main className="app-shell__main" id="main-content">
				{activePage === "conversation" ? (
					<ConversationDestination controller={conversationController} />
				) : null}
				{activePage === "planning" ? (
					<PlanningPage
						controller={planningController}
						onNotify={showNotice}
						onOpenCalendar={() => setActivePage("calendar")}
						renderSchedulePreview={(props) => (
							<PlanningSchedulePreview {...props} />
						)}
					/>
				) : null}
				{activePage === "calendar" ? (
					<CalendarPage
						onNotify={showNotice}
						service={calendarService}
						controller={resolvedCalendarController}
						initialScenario={null}
						showScenarioControl={enableQaControls}
					/>
				) : null}
				{activePage === "history" ? (
					<ProactiveFeedbackHistoryPage
						controller={proactiveFeedbackHistoryController}
					/>
				) : null}
				{activePage === "reports" ? (
					<ReportsPage controller={reportController} />
				) : null}
				{activePage === "settings" ? (
					<SettingsPage
						user={user}
						controller={preferencesController}
						monitoringController={monitoringController}
						auditExportService={auditExportService}
						agentPermissionsController={agentPermissionsController}
						proactiveFeedbackPolicyController={
							proactiveFeedbackPolicyController
						}
						appUpdateController={appUpdateController}
						category={settingsCategory}
						onCategoryChange={setSettingsCategory}
						onLogout={() => setLogoutDialogOpen(true)}
						onPreferencesApplied={handlePreferencesApplied}
						onProactiveFeedbackCleared={() =>
							proactiveFeedbackHistoryController.notifyCleared()
						}
					/>
				) : null}
			</main>

			{notice ? (
				<div className="app-toast" role="status" aria-live="polite">
					<Settings size={15} aria-hidden="true" />
					<span>{notice}</span>
				</div>
			) : null}

			{logoutDialogOpen ? (
				<ConfirmationDialog
					title="退出当前账号？"
					description="WhaleHall 会立即清理当前本地测试会话并返回登录页。本机计划、日程和偏好不会被删除。"
					confirmLabel="退出登录"
					onCancel={() => setLogoutDialogOpen(false)}
					onConfirm={() => {
						setLogoutDialogOpen(false);
						onLogout();
					}}
					returnFocusRef={userMenuTriggerRef}
				/>
			) : null}
		</div>
	);
}

function ConversationDestination({
	controller,
}: {
	controller: ConversationController;
}) {
	const state = useSyncExternalStore(
		controller.subscribe,
		controller.getSnapshot,
		controller.getServerSnapshot,
	);

	useEffect(() => {
		if (state.status === "loading") void controller.load();
	}, [controller, state.status]);

	return (
		<ConversationPage
			state={state}
			actions={{
				onCreateConversation: () => void controller.createConversation(),
				onSendMessage: (draft) => void controller.sendMessage(draft),
				onRetry: () => void controller.retry(),
				onStopRun: () => void controller.stopRun(),
				onApproveTool: () => void controller.approveTool(),
				onDeclineTool: () => void controller.declineTool(),
				onRestoreRun: (runId) => void controller.resumeInterruptedRun(runId),
			}}
		/>
	);
}
