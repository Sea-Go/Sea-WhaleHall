import { useState } from "react";
import {
	type ProactiveFeedbackHistoryController,
	ProactiveFeedbackHistoryPage,
} from "../proactive-feedback/public";
import type { CloudHistoryController } from "./CloudHistoryController";
import { CloudHistoryPage } from "./CloudHistoryPage";
import "./HistoryWorkspace.css";

/** Both histories share the main window but keep their authorities and paging separate. */
export function HistoryWorkspace({
	local,
	cloud,
}: {
	local: ProactiveFeedbackHistoryController;
	cloud: CloudHistoryController;
}) {
	const [tab, setTab] = useState<"local" | "cloud">("local");
	return (
		<section className="history-workspace">
			<div
				className="history-workspace__tabs"
				role="tablist"
				aria-label="历史记录来源"
			>
				<button
					type="button"
					role="tab"
					aria-selected={tab === "local"}
					onClick={() => {
						cloud.setVisible(false);
						setTab("local");
					}}
				>
					本地主动反馈
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={tab === "cloud"}
					onClick={() => setTab("cloud")}
				>
					云端问答
				</button>
			</div>
			<div className="history-workspace__body" role="tabpanel">
				{tab === "local" ? (
					<ProactiveFeedbackHistoryPage controller={local} />
				) : (
					<CloudHistoryPage controller={cloud} />
				)}
			</div>
		</section>
	);
}
