import { CloudOff, RefreshCw } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { Button } from "../../shared/ui/Button";
import { EmptyState } from "../../shared/ui/EmptyState";
import { PageHeader } from "../../shared/ui/PageHeader";
import type { CloudHistoryController } from "./CloudHistoryController";
import "./CloudHistoryPage.css";

export function CloudHistoryPage({
	controller,
}: {
	controller: CloudHistoryController;
}) {
	const state = useSyncExternalStore(
		controller.subscribe,
		controller.getSnapshot,
		controller.getServerSnapshot,
	);
	useEffect(() => {
		controller.setVisible(true);
		return () => controller.setVisible(false);
	}, [controller]);
	return (
		<div className="cloud-history-page">
			<PageHeader
				eyebrow="云端问答"
				title="已接纳答案"
				description="按 RTW 的接纳顺序查看问答。引用状态以当前知识库为准；撤回的引用不会展示旧摘录。"
			/>
			{state.status === "disabled" && (
				<div className="cloud-history-page__state">
					<EmptyState
						icon={<CloudOff size={22} />}
						eyebrow="尚未连接"
						title="云端历史暂不可用"
						description="当前账号尚无 RTW 产品会话或问答会话关联。完成关联后，这里才会读取本人的已接纳答案。"
					/>
				</div>
			)}
			{state.status === "loading" && (
				<p className="cloud-history-page__message" role="status">
					正在读取云端历史…
				</p>
			)}
			{state.status === "empty" && (
				<div className="cloud-history-page__state">
					<EmptyState
						icon={<CloudOff size={22} />}
						eyebrow="暂无记录"
						title="还没有已接纳的云端答案"
						description="当前问答会话没有已接纳答案。"
					/>
				</div>
			)}
			{state.status === "error" && state.items.length === 0 && (
				<div className="cloud-history-page__state">
					<EmptyState
						icon={<RefreshCw size={22} />}
						eyebrow="读取失败"
						title="暂时无法读取云端历史"
						description={failureText(state.reason)}
						action={
							<Button onClick={() => void controller.load()}>重新读取</Button>
						}
					/>
				</div>
			)}
			{"items" in state && state.items.length > 0 && (
				<div className="cloud-history-page__content">
					{state.items.map((item) => (
						<article
							className="cloud-history-entry"
							key={`${item.sessionId}:${item.answerId}:${item.acceptedOrdinal}`}
						>
							<div className="cloud-history-entry__meta">
								<time dateTime={item.acceptedAt}>
									{new Date(item.acceptedAt).toLocaleString()}
								</time>
								<span>第 {item.acceptedOrdinal} 条</span>
							</div>
							<h2>{item.question}</h2>
							<p className="cloud-history-entry__answer">
								{item.answer ?? "本次检索证据不足，未生成总结。"}
							</p>
							<div className="cloud-history-entry__citations">
								<strong>引用状态</strong>
								{item.citationState !== "verified" ? (
									<p>当前引用状态无法核验，暂不展示引用内容。</p>
								) : item.citations.length === 0 ? (
									<p>这条答案没有引用。</p>
								) : (
									<ul>
										{item.citations.map((citation) => (
											<li key={citation.evidenceId}>
												{citation.state === "available"
													? "可用"
													: "已撤回或不可用"}{" "}
												· {citation.sourceKind} · {citation.contentId} · 修订{" "}
												{citation.revisionId}
											</li>
										))}
									</ul>
								)}
							</div>
						</article>
					))}
					{state.status === "error" && (
						<p role="alert">
							{failureText(state.reason)}{" "}
							<Button
								size="small"
								variant="ghost"
								onClick={() => void controller.loadMore()}
							>
								重试
							</Button>
						</p>
					)}
					{state.nextOrdinal && state.status !== "error" && (
						<Button
							variant="ghost"
							disabled={state.status === "loading-more"}
							onClick={() => void controller.loadMore()}
						>
							{state.status === "loading-more"
								? "正在读取…"
								: "读取后续已接纳答案"}
						</Button>
					)}
				</div>
			)}
		</div>
	);
}

function failureText(reason: string): string {
	switch (reason) {
		case "signed_out":
			return "产品会话已失效，请重新登录。";
		case "session_changed":
			return "账号已切换，旧账号的历史记录已清除。";
		case "offline":
			return "网络不可用，未读取新的历史记录。";
		default:
			return "服务暂不可用，请稍后重试。";
	}
}
