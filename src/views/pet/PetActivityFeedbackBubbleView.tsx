import type { SyntheticEvent } from "react";
import type { PetActivityFeedbackPage } from "./activity-feedback";
import { SafePetMarkdown } from "./SafePetMarkdown";

export interface PetActivityFeedbackBubbleViewProps {
	page: PetActivityFeedbackPage | null;
	onNext: () => void;
	onDismiss: () => void;
}

function stopPetInteraction(event: SyntheticEvent): void {
	event.stopPropagation();
}

function runPetFeedbackAction(event: SyntheticEvent, action: () => void): void {
	stopPetInteraction(event);
	action();
}

export function PetActivityFeedbackBubbleView({
	page,
	onNext,
	onDismiss,
}: PetActivityFeedbackBubbleViewProps) {
	if (page === null) return null;
	const hasMorePages = page.pageNumber < page.pageCount;
	return (
		<div className="pet-activity-feedback">
			<div
				className="pet-activity-feedback__announcement"
				role="status"
				aria-live="polite"
				aria-atomic="true"
				aria-label="Agent 主动反馈"
			>
				<div className="pet-activity-feedback__header">
					<span>小鲸的观察</span>
					<span className="pet-activity-feedback__progress">
						<span className="pet-visually-hidden">
							第 {page.pageNumber} 段，共 {page.pageCount} 段
						</span>
						<span aria-hidden="true">
							{page.pageNumber}/{page.pageCount}
						</span>
					</span>
				</div>
				<div className="pet-activity-feedback__message">
					<SafePetMarkdown content={page.content} fallbackText={page.text} />
				</div>
			</div>
			<div className="pet-activity-feedback__actions">
				<button
					type="button"
					onPointerDown={stopPetInteraction}
					onPointerUp={stopPetInteraction}
					onClick={(event) => runPetFeedbackAction(event, onDismiss)}
				>
					收起剩余
				</button>
				<button
					type="button"
					className="pet-activity-feedback__primary-action"
					onPointerDown={stopPetInteraction}
					onPointerUp={stopPetInteraction}
					onClick={(event) => runPetFeedbackAction(event, onNext)}
				>
					{hasMorePages ? "下一段" : "完成"}
				</button>
			</div>
		</div>
	);
}
