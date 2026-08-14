import { ChevronDown, ChevronUp, History, RefreshCw } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "../../shared/ui/Button";
import { EmptyState } from "../../shared/ui/EmptyState";
import { PageHeader } from "../../shared/ui/PageHeader";
import {
	formatProactiveFeedbackTime,
	groupProactiveFeedbackByLocalDay,
} from "./domain";
import type { ProactiveFeedbackHistoryController } from "./ProactiveFeedbackHistoryController";
import "./ProactiveFeedbackHistoryPage.css";

const COLLAPSED_MESSAGE_CHARACTERS = 320;

export interface ProactiveFeedbackHistoryPageProps {
	controller: ProactiveFeedbackHistoryController;
}

export function ProactiveFeedbackHistoryPage({
	controller,
}: ProactiveFeedbackHistoryPageProps) {
	const state = useSyncExternalStore(
		controller.subscribe,
		controller.getSnapshot,
		controller.getServerSnapshot,
	);
	const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(
		() => new Set(),
	);

	useEffect(() => {
		controller.setVisible(true);
		return () => controller.setVisible(false);
	}, [controller]);

	const toggleExpanded = (id: string) => {
		setExpandedIds((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	return (
		<div className="proactive-history-page">
			<PageHeader
				eyebrow="主动反馈"
				title="历史记录"
				description="查看 WhaleHall 根据活动事件流生成的反馈。这里只显示生成时间和最终消息。"
			/>

			{state.status === "idle" || state.status === "loading" ? (
				<HistoryLoading />
			) : null}

			{state.status === "empty" ? (
				<div className="proactive-history-page__state">
					<EmptyState
						icon={<History size={22} />}
						eyebrow="还没有反馈"
						title="新的反馈会出现在这里"
						description="触发器累计到足够相关的活动后，Agent 生成的最终消息会按时间保存。"
					/>
				</div>
			) : null}

			{state.status === "error" && state.stage === "initial" ? (
				<div className="proactive-history-page__state">
					<EmptyState
						icon={<RefreshCw size={21} />}
						eyebrow="历史记录未载入"
						title="暂时无法读取反馈"
						description={state.message}
						action={
							<Button onClick={() => void controller.load()}>重新读取</Button>
						}
					/>
				</div>
			) : null}

			{"items" in state ? (
				<HistoryList
					state={state}
					expandedIds={expandedIds}
					onToggleExpanded={toggleExpanded}
					onLoadMore={() => void controller.loadMore()}
				/>
			) : null}
		</div>
	);
}

function HistoryList({
	state,
	expandedIds,
	onToggleExpanded,
	onLoadMore,
}: {
	state: Extract<
		ReturnType<ProactiveFeedbackHistoryController["getSnapshot"]>,
		{ items: readonly unknown[] }
	>;
	expandedIds: ReadonlySet<string>;
	onToggleExpanded: (id: string) => void;
	onLoadMore: () => void;
}) {
	const groups = groupProactiveFeedbackByLocalDay(state.items);
	return (
		<div className="proactive-history-page__content">
			{groups.map((group) => (
				<section className="proactive-history-group" key={group.key}>
					<h2>{group.label}</h2>
					<div className="proactive-history-group__items">
						{group.items.map((item) => {
							const collapsible =
								item.message.length > COLLAPSED_MESSAGE_CHARACTERS;
							const expanded = expandedIds.has(item.id);
							return (
								<article className="proactive-history-entry" key={item.id}>
									<time dateTime={new Date(item.generatedAtMs).toISOString()}>
										{formatProactiveFeedbackTime(item.generatedAtMs)}
									</time>
									<div className="proactive-history-entry__body">
										<p
											className={
												collapsible && !expanded
													? "proactive-history-entry__message proactive-history-entry__message--collapsed"
													: "proactive-history-entry__message"
											}
										>
											{item.message}
										</p>
										{collapsible ? (
											<button
												className="proactive-history-entry__expand"
												type="button"
												aria-expanded={expanded}
												onClick={() => onToggleExpanded(item.id)}
											>
												{expanded ? (
													<ChevronUp size={14} aria-hidden="true" />
												) : (
													<ChevronDown size={14} aria-hidden="true" />
												)}
												{expanded ? "收起全文" : "展开全文"}
											</button>
										) : null}
									</div>
								</article>
							);
						})}
					</div>
				</section>
			))}

			{state.status === "error" && state.stage === "more" ? (
				<div className="proactive-history-page__more-error" role="alert">
					<span>{state.message}</span>
					<Button size="small" variant="ghost" onClick={onLoadMore}>
						重试
					</Button>
				</div>
			) : null}

			{state.nextCursor ? (
				<div className="proactive-history-page__load-more">
					<Button
						variant="ghost"
						disabled={state.status === "loading-more"}
						onClick={onLoadMore}
					>
						{state.status === "loading-more" ? "正在载入…" : "载入更早记录"}
					</Button>
				</div>
			) : null}
		</div>
	);
}

function HistoryLoading() {
	return (
		<div className="proactive-history-loading" role="status" aria-live="polite">
			<span aria-hidden="true" />
			<div>
				<strong>正在读取历史记录</strong>
				<p>从当前账号的本地加密存储载入最终反馈。</p>
			</div>
		</div>
	);
}
