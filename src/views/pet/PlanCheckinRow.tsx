import { useState } from "react";
import type { PlanCheckinOutcome } from "./plan-lifecycle";

export interface PlanCheckinRowProps {
	itemId: string;
	/** Disabled while a check-in is in flight or the item is not checkable. */
	disabled?: boolean;
	onCheckin: (
		itemId: string,
		outcome: PlanCheckinOutcome,
		note?: string,
	) => void;
}

const OUTCOME_LABELS: Record<PlanCheckinOutcome, string> = {
	done: "完成",
	postponed: "推迟",
	skipped: "跳过",
};

/**
 * Check-in three-key row (方案 §3-3): 完成/推迟/跳过 plus an optional
 * collapsible "为什么" note. The note 只入记忆，不写计划——it feeds memory
 * and later 复盘 insights, never the plan record itself. Whichever key is
 * pressed next submits together with the typed note.
 */
export function PlanCheckinRow({
	itemId,
	disabled = false,
	onCheckin,
}: PlanCheckinRowProps) {
	const [noteOpen, setNoteOpen] = useState(false);
	const [note, setNote] = useState("");

	const submit = (outcome: PlanCheckinOutcome) => {
		const trimmed = note.trim();
		onCheckin(itemId, outcome, trimmed.length > 0 ? trimmed : undefined);
		setNote("");
		setNoteOpen(false);
	};

	return (
		<div className="pet-plan-checkin">
			<fieldset className="pet-plan-checkin__keys">
				<legend className="pet-visually-hidden">打卡</legend>
				{(["done", "postponed", "skipped"] as const).map((outcome) => (
					<button
						key={outcome}
						type="button"
						className={
							outcome === "done"
								? "pet-plan-checkin__key pet-plan-checkin__key--done"
								: "pet-plan-checkin__key"
						}
						disabled={disabled}
						onClick={() => submit(outcome)}
					>
						{OUTCOME_LABELS[outcome]}
					</button>
				))}
				<button
					type="button"
					className="pet-plan-checkin__why-toggle"
					aria-expanded={noteOpen}
					disabled={disabled}
					onClick={() => setNoteOpen((value) => !value)}
				>
					为什么？
				</button>
			</fieldset>
			{noteOpen && (
				<div className="pet-plan-checkin__note">
					<label>
						<span className="pet-plan-checkin__note-hint">
							可选：写一句原因，只入记忆、不写计划
						</span>
						<input
							type="text"
							value={note}
							onChange={(event) => setNote(event.target.value)}
							placeholder="例如：昨晚没睡好"
							disabled={disabled}
						/>
					</label>
				</div>
			)}
		</div>
	);
}
