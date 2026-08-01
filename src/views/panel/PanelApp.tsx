import { useEffect, useState } from "react";
import type { PetTodaySchedule } from "../../shared/pet-panel";
import { panelApi } from "./rpc";

const initialSchedule: PetTodaySchedule = {
	status: "loading",
	date: "",
	timeZone: "",
	tasks: [],
};

export function PanelApp() {
	const [schedule, setSchedule] = useState<PetTodaySchedule>(initialSchedule);

	useEffect(() => {
		const unsubscribe = panelApi.onTodaySchedule(setSchedule);
		void panelApi.getTodaySchedule().then(setSchedule).catch(() => {
			setSchedule((current) => ({ ...current, status: "unavailable" }));
		});
		return unsubscribe;
	}, []);

	return (
		<main className="pet-panel" aria-labelledby="pet-panel-title">
			<header className="pet-panel__header">
				<div>
					<p>WhaleHall</p>
					<h1 id="pet-panel-title">今日任务</h1>
					<span>{schedule.date || "正在读取日期"}</span>
				</div>
				<button
					type="button"
					className="pet-panel__close"
					aria-label="关闭今日任务面板"
					onClick={() => void panelApi.close()}
				>
					关闭
				</button>
			</header>

			<section className="pet-panel__tasks" aria-live="polite" aria-label="今天的任务">
				{schedule.status === "loading" ? (
					<p className="pet-panel__state">正在同步今天的安排…</p>
				) : schedule.status === "unavailable" ? (
					<p className="pet-panel__state">暂时无法读取日历。打开主界面后可重试。</p>
				) : schedule.tasks.length === 0 ? (
					<p className="pet-panel__state">今天还没有计划任务，留一点空白也很好。</p>
				) : (
					<ul>
						{schedule.tasks.map((task) => (
							<li key={task.id}>
								<time>{task.timeLabel}</time>
								<div>
									<strong>{task.title}</strong>
									{task.state === "proposed" ? <span>待确认</span> : null}
								</div>
							</li>
						))}
					</ul>
				)}
			</section>

			<footer>
				<button type="button" onClick={() => void panelApi.openMain()}>
					打开主界面
				</button>
			</footer>
		</main>
	);
}
