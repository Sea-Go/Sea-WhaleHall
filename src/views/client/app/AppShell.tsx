import {
	CalendarDays,
	Cat,
	ChartNoAxesCombined,
	ChevronUp,
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AuthUser } from "../features/auth/public";
import {
	CalendarPage,
	CalendarController,
	type CalendarControllerState,
	type CalendarService,
} from "../features/calendar/public";
import { Temporal } from "temporal-polyfill";
import type { PetTodaySchedule } from "../../../shared/pet-panel";
import {
	PlanningPage,
	type PlanningController,
} from "../features/planning/public";
import {
	ReportsPage,
	type ReportController,
} from "../features/reports/public";
import type { PetPresentationBridge } from "../features/pet-bridge/public";
import {
	ConversationPage,
	type ConversationPageActions,
	type ConversationPageState,
} from "../features/conversation/public";
import {
	SettingsPage,
	type AgentPermissionsController,
	type PreferencesController,
	type PreferencesSnapshot,
	type SettingsCategory,
} from "../features/settings/public";
import { ConfirmationDialog } from "../shared/ui/ConfirmationDialog";
import { applyAppearancePreferences } from "./appearance";
import { PlanningSchedulePreview } from "./PlanningSchedulePreview";
import { PlanningPetCoordinator } from "./PlanningPetCoordinator";
import { PAGE_LABELS, type PageId } from "./navigation";

type MenuAction = "account" | "appearance" | "pet" | "privacy" | "logout";

const navigationItems = [
	{ id: "planning", label: PAGE_LABELS.planning, icon: Target, disabled: false },
	{ id: "calendar", label: PAGE_LABELS.calendar, icon: CalendarDays, disabled: false },
	{ id: "conversation", label: PAGE_LABELS.conversation, icon: MessageCircle, disabled: false },
	{ id: "reports", label: PAGE_LABELS.reports, icon: ChartNoAxesCombined, disabled: false },
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
] as const satisfies ReadonlyArray<{
	id: Exclude<MenuAction, "logout">;
	label: string;
	icon: typeof UserRound;
}>;

export function calendarStateToPetTodaySchedule(
	snapshot: CalendarControllerState,
	dateOverride?: string,
): PetTodaySchedule {
	const timeZone = snapshot.timeZone;
	const date = dateOverride ?? Temporal.Now.zonedDateTimeISO(timeZone).toPlainDate().toString();
	if (snapshot.loadState !== "ready") {
		return { status: "unavailable", date, timeZone, tasks: [] };
	}
	return {
		status: "ready",
		date,
		timeZone,
		tasks: snapshot.events
			.filter((event) => event.kind === "plan")
			.filter((event) => {
				if (event.schedule.allDay) {
					return event.schedule.startDate <= date && date < event.schedule.endDateExclusive;
				}
				return Temporal.Instant.from(event.schedule.start)
					.toZonedDateTimeISO(event.schedule.timeZone)
					.toPlainDate()
					.toString() === date;
			})
			.map((event) => {
				if (event.schedule.allDay) {
					return { id: event.id, title: event.title, timeLabel: "全天", state: event.state };
				}
				const start = Temporal.Instant.from(event.schedule.start)
					.toZonedDateTimeISO(event.schedule.timeZone)
					.toPlainTime()
					.toString({ smallestUnit: "minute" });
				const end = Temporal.Instant.from(event.schedule.end)
					.toZonedDateTimeISO(event.schedule.timeZone)
					.toPlainTime()
					.toString({ smallestUnit: "minute" });
				return { id: event.id, title: event.title, timeLabel: `${start}–${end}`, state: event.state };
			})
			.sort((left, right) => left.timeLabel.localeCompare(right.timeLabel)),
	};
}

export interface AppShellProps {
	user: AuthUser;
	onLogout: () => void;
	calendarService: CalendarService;
	calendarController?: CalendarController;
	planningController: PlanningController;
	reportController: ReportController;
	preferencesController: PreferencesController;
	agentPermissionsController?: AgentPermissionsController;
	petBridge: PetPresentationBridge;
	conversationState: ConversationPageState;
	conversationActions?: ConversationPageActions;
	initialPage?: PageId;
	enableQaControls?: boolean;
}

export function AppShell({
	user,
	onLogout,
	calendarService,
	calendarController,
	planningController,
	reportController,
	preferencesController,
	agentPermissionsController,
	petBridge,
	conversationState,
	conversationActions,
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
		const publish = () => {
			void petBridge.updateTodaySchedule(
				calendarStateToPetTodaySchedule(resolvedCalendarController.getSnapshot()),
			);
		};
		publish();
		return resolvedCalendarController.subscribe(publish);
	}, [petBridge, resolvedCalendarController]);

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
		return () => document.removeEventListener("pointerdown", handleOutsidePointer);
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
			petReactionsEnabledRef.current =
				snapshot.values.pet.reactionsEnabled;
			planningPetCoordinator.setEnabled(
				snapshot.values.pet.reactionsEnabled,
			);
			void petBridge.setVisible(snapshot.values.pet.visible);
		},
		[petBridge, planningPetCoordinator],
	);

	function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		const menuItems = Array.from(
			userMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
		);
		if (menuItems.length === 0) return;

		if (event.key === "Escape") {
			event.preventDefault();
			closeUserMenu();
			return;
		}

		if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
		event.preventDefault();
		const currentIndex = menuItems.findIndex((item) => item === document.activeElement);
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
								{active ? <span className="primary-navigation__active-dot" /> : null}
							</button>
						);
					})}
				</nav>

				<div className="app-sidebar__insight">
					<div className="app-sidebar__insight-icon" aria-hidden="true">
						<Target size={16} />
					</div>
					<div>
						<strong>本周，从一件事开始</strong>
						<span>制定计划后，这里会显示你的投入节奏。</span>
					</div>
				</div>

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
								<span className="user-avatar user-avatar--small" aria-hidden="true">
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
						<ChevronUp
							className={userMenuOpen ? "user-entry__chevron--open" : undefined}
							size={17}
							aria-hidden="true"
						/>
					</button>
				</div>
			</aside>

			<main className="app-shell__main" id="main-content">
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
				{activePage === "conversation" ? (
					<ConversationPage
						state={conversationState}
						actions={conversationActions}
					/>
				) : null}
				{activePage === "reports" ? (
					<ReportsPage controller={reportController} />
				) : null}
				{activePage === "settings" ? (
					<SettingsPage
						user={user}
						controller={preferencesController}
						agentPermissionsController={agentPermissionsController}
						category={settingsCategory}
						onCategoryChange={setSettingsCategory}
						onLogout={() => setLogoutDialogOpen(true)}
						onPreferencesApplied={handlePreferencesApplied}
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
