import {
	ArrowRight,
	CircleAlert,
	Eye,
	EyeOff,
	LoaderCircle,
	ServerOff,
	ShieldCheck,
	Sparkles,
	Waves,
	WifiOff,
} from "lucide-react";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useState } from "react";
import { Button } from "../../shared/ui/Button";
import type {
	AuthCredentials,
	AuthExperienceCredentials,
	AuthState,
} from "./domain";

export type LoginAuthState = Extract<
	AuthState,
	{
		status: "unauthenticated" | "authenticating" | "error" | "expired";
	}
>;

export interface AuthPageProps {
	state: LoginAuthState;
	experienceCredentials?: AuthExperienceCredentials;
	onSubmit: (credentials: AuthCredentials) => Promise<void>;
	onRetry: () => Promise<void>;
}

interface FormValidation {
	email?: string;
	password?: string;
}

export function AuthPage({
	state,
	experienceCredentials,
	onSubmit,
	onRetry,
}: AuthPageProps) {
	const [email, setEmail] = useState(
		state.status === "error" && state.email
			? state.email
			: (experienceCredentials?.email ?? ""),
	);
	const [password, setPassword] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [validation, setValidation] = useState<FormValidation>({});
	const authenticating = state.status === "authenticating";
	const notice = getAuthNotice(state);

	function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (authenticating) return;

		const nextValidation: FormValidation = {};
		const normalizedEmail = email.trim();
		if (!normalizedEmail) {
			nextValidation.email = "请输入邮箱地址。";
		} else if (!normalizedEmail.includes("@")) {
			nextValidation.email = "请输入有效的邮箱地址。";
		}
		if (!password) nextValidation.password = "请输入密码。";
		setValidation(nextValidation);
		if (nextValidation.email || nextValidation.password) return;

		const submittedPassword = password;
		setPassword("");
		setShowPassword(false);
		void onSubmit({ email: normalizedEmail, password: submittedPassword });
	}

	function handleFormKeyDown(event: ReactKeyboardEvent<HTMLFormElement>) {
		if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
		if (
			event.target instanceof HTMLButtonElement &&
			event.target.type === "button"
		) {
			return;
		}
		event.preventDefault();
		event.currentTarget.requestSubmit();
	}

	return (
		<main className="auth-page">
			<section className="auth-atmosphere" aria-labelledby="auth-brand-title">
				<div className="auth-atmosphere__glow" aria-hidden="true" />
				<div className="auth-brand">
					<span className="auth-brand__mark" aria-hidden="true">
						<Waves size={22} strokeWidth={2} />
					</span>
					<div>
						<strong>WhaleHall</strong>
						<span>把时间留给重要的事</span>
					</div>
				</div>

				<div className="auth-atmosphere__copy">
					<p>
						<Sparkles size={14} aria-hidden="true" />
						个人计划与成长空间
					</p>
					<h1 id="auth-brand-title">把模糊的目标，放进清晰的一周</h1>
					<span>
						从计划到日程，再到每一次回顾。WhaleHall
						帮助你把注意力放回真正重要的事情。
					</span>
				</div>

				<div className="auth-ocean" aria-hidden="true">
					<div className="auth-ocean__whale">
						<Waves size={34} strokeWidth={1.45} />
					</div>
					<span className="auth-ocean__orbit auth-ocean__orbit--one" />
					<span className="auth-ocean__orbit auth-ocean__orbit--two" />
					<span className="auth-ocean__orbit auth-ocean__orbit--three" />
					<i className="auth-ocean__point auth-ocean__point--one" />
					<i className="auth-ocean__point auth-ocean__point--two" />
				</div>

				<div className="auth-privacy-note">
					<ShieldCheck size={17} aria-hidden="true" />
					<div>
						<strong>登录信息由安全边界处理</strong>
						<span>体验密码只用于本机校验，不会发送到远端。</span>
					</div>
				</div>
			</section>

			<section className="auth-panel-region" aria-labelledby="auth-panel-title">
				<div className="auth-panel">
					<header className="auth-panel__header">
						<p>欢迎回来</p>
						<h2 id="auth-panel-title">登录 WhaleHall</h2>
						<span>当前体验账号只在本机验证，正式远端账户认证将在后续提供。</span>
					</header>

					{notice ? <AuthNotice notice={notice} onRetry={onRetry} /> : null}

					<form
						className="auth-form"
						onSubmit={handleSubmit}
						onKeyDown={handleFormKeyDown}
						aria-busy={authenticating}
						noValidate
					>
						<div className="auth-field">
							<label htmlFor="auth-email">邮箱</label>
							<input
								id="auth-email"
								name="email"
								type="email"
								value={email}
								autoComplete="username"
								inputMode="email"
								disabled={authenticating}
								aria-invalid={validation.email ? "true" : undefined}
								aria-describedby={
									validation.email ? "auth-email-error" : undefined
								}
								onChange={(event) => {
									setEmail(event.target.value);
									setValidation((current) => ({
										...current,
										email: undefined,
									}));
								}}
							/>
							{validation.email ? (
								<small id="auth-email-error" className="auth-field__error">
									{validation.email}
								</small>
							) : null}
						</div>

						<div className="auth-field">
							<div className="auth-field__heading">
								<label htmlFor="auth-password">密码</label>
								{experienceCredentials ? (
									<span>体验密码：{experienceCredentials.password}</span>
								) : null}
							</div>
							<div className="auth-password-control">
								<input
									id="auth-password"
									name="password"
									type={showPassword ? "text" : "password"}
									value={password}
									autoComplete="current-password"
									disabled={authenticating}
									aria-invalid={validation.password ? "true" : undefined}
									aria-describedby={
										validation.password ? "auth-password-error" : undefined
									}
									onChange={(event) => {
										setPassword(event.target.value);
										setValidation((current) => ({
											...current,
											password: undefined,
										}));
									}}
								/>
								<button
									className="auth-password-toggle"
									type="button"
									aria-label={showPassword ? "隐藏密码" : "显示密码"}
									title={showPassword ? "隐藏密码" : "显示密码"}
									disabled={authenticating}
									onClick={() => setShowPassword((current) => !current)}
								>
									{showPassword ? (
										<EyeOff size={17} aria-hidden="true" />
									) : (
										<Eye size={17} aria-hidden="true" />
									)}
								</button>
							</div>
							{validation.password ? (
								<small id="auth-password-error" className="auth-field__error">
									{validation.password}
								</small>
							) : null}
						</div>

						<Button
							className="auth-submit"
							variant="primary"
							size="medium"
							type="submit"
							disabled={authenticating}
							icon={
								authenticating ? (
									<LoaderCircle
										className="auth-spinner"
										size={17}
										aria-hidden="true"
									/>
								) : (
									<ArrowRight size={17} aria-hidden="true" />
								)
							}
						>
							{authenticating ? "正在登录…" : "登录"}
						</Button>
					</form>

					{experienceCredentials ? (
						<div className="auth-experience-note">
							<strong>本地体验模式</strong>
							<span>
								体验账号已预填。邮箱和密码只提交给桌面主进程做固定值校验，不会上传。
							</span>
						</div>
					) : null}
				</div>

				<footer className="auth-panel-region__footer">
					<span>WhaleHall 桌面端</span>
					<span>隐私优先 · 本地数据边界</span>
				</footer>
			</section>
		</main>
	);
}

export interface AuthBootScreenProps {
	operation: Extract<AuthState, { status: "booting" }>["operation"];
}

export function AuthBootScreen({ operation }: AuthBootScreenProps) {
	const message =
		operation === "signing-out"
			? "正在安全退出"
			: operation === "retrying"
				? "正在重新连接登录服务"
				: "正在确认登录状态";

	return (
		<main className="auth-boot-screen">
			<div className="auth-boot-screen__ambient" aria-hidden="true" />
			<div className="auth-boot-screen__content" role="status" aria-live="polite">
				<span className="auth-brand__mark" aria-hidden="true">
					<Waves size={22} strokeWidth={2} />
				</span>
				<LoaderCircle
					className="auth-spinner"
					size={20}
					aria-hidden="true"
				/>
				<h1>{message}</h1>
				<p>WhaleHall 不会在会话确认前显示受保护内容。</p>
			</div>
		</main>
	);
}

interface AuthNoticeModel {
	kind: "success" | "invalid-credentials" | "offline" | "service" | "expired" | "unexpected";
	title: string;
	message: string;
	retryable: boolean;
}

function getAuthNotice(state: LoginAuthState): AuthNoticeModel | null {
	switch (state.status) {
		case "unauthenticated":
			return state.notice
				? {
						kind: "success",
						title: "会话已结束",
						message: state.notice,
						retryable: false,
					}
				: null;
		case "authenticating":
			return null;
		case "expired":
			return {
				kind: "expired",
				title: "会话已过期",
				message: state.message,
				retryable: false,
			};
		case "error": {
			const title =
				state.failure.kind === "invalid-credentials"
					? "无法登录"
					: state.failure.kind === "offline"
						? "设备已离线"
						: state.failure.kind === "service-unavailable"
							? "服务暂时不可用"
							: "登录遇到问题";
			const kind =
				state.failure.kind === "service-unavailable"
					? "service"
					: state.failure.kind === "invalid-credentials" ||
						  state.failure.kind === "offline"
						? state.failure.kind
						: "unexpected";
			return {
				kind,
				title,
				message: state.failure.message,
				retryable: state.failure.retryable,
			};
		}
	}
}

function AuthNotice({
	notice,
	onRetry,
}: {
	notice: AuthNoticeModel;
	onRetry: () => Promise<void>;
}) {
	const Icon =
		notice.kind === "offline"
			? WifiOff
			: notice.kind === "service"
				? ServerOff
				: notice.kind === "success"
					? ShieldCheck
					: CircleAlert;

	return (
		<div
			className={`auth-notice auth-notice--${notice.kind}`}
			role={notice.kind === "success" ? "status" : "alert"}
			aria-live="polite"
		>
			<Icon size={18} aria-hidden="true" />
			<div>
				<strong>{notice.title}</strong>
				<span>{notice.message}</span>
			</div>
			{notice.retryable ? (
				<button type="button" onClick={() => void onRetry()}>
					重试连接
				</button>
			) : null}
		</div>
	);
}
