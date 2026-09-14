import { type SyntheticEvent, useEffect, useRef, useState } from "react";
import {
	PetCloudSearchController,
	type PetCloudSearchPort,
	type PetCloudSearchState,
} from "./cloud-search";

export interface PetCloudSearchPanelProps {
	/** Remains null until Bun has a real account-bound RTW product session. */
	port: PetCloudSearchPort | null;
}

function stopPetInteraction(event: SyntheticEvent): void {
	event.stopPropagation();
}

export function PetCloudSearchPanel({ port }: PetCloudSearchPanelProps) {
	const [query, setQuery] = useState("");
	const [state, setState] = useState<PetCloudSearchState>(
		port
			? { kind: "idle" }
			: { kind: "unavailable", message: "知识会话尚未连接，云搜索暂不可用。" },
	);
	const controllerRef = useRef<PetCloudSearchController | null>(null);

	useEffect(() => {
		const controller = new PetCloudSearchController(port, setState);
		controllerRef.current = controller;
		setState(controller.state);
		return () => {
			controller.dispose();
			if (controllerRef.current === controller) controllerRef.current = null;
		};
	}, [port]);

	const unavailable = state.kind === "unavailable";
	const searching = state.kind === "searching";
	return (
		<section
			className="pet-cloud-search"
			aria-label="桌宠云搜索"
			onClick={stopPetInteraction}
			onKeyDown={stopPetInteraction}
			onPointerDown={stopPetInteraction}
			onPointerUp={stopPetInteraction}
		>
			<div className="pet-cloud-search__header">
				<strong>云搜索</strong>
				{searching && (
					<button type="button" onClick={() => controllerRef.current?.cancel()}>
						取消
					</button>
				)}
			</div>
			{unavailable ? (
				<div className="pet-cloud-search__unavailable">
					<span role="status">{state.message}</span>
					<button type="button" disabled>
						搜索
					</button>
				</div>
			) : (
				<>
					<form
						className="pet-cloud-search__form"
						onSubmit={(event) => {
							event.preventDefault();
							event.stopPropagation();
							void controllerRef.current?.start(query);
						}}
					>
						<input
							aria-label="搜索问题"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder="想了解什么？"
							disabled={searching}
						/>
						<button
							type="submit"
							disabled={searching || query.trim().length === 0}
						>
							搜索
						</button>
					</form>
					<div
						className="pet-cloud-search__result"
						role={state.kind === "failed" ? "alert" : "status"}
						aria-live="polite"
					>
						{state.kind === "idle" && "输入问题后由小鲸查找资料。"}
						{state.kind === "searching" && "正在搜索，尚无可展示的答案。"}
						{state.kind === "cancelled" && "搜索已取消。"}
						{state.kind === "insufficient" && "目前没有足够证据回答这个问题。"}
						{state.kind === "failed" && state.message}
						{state.kind === "answered" && (
							<>
								<p className="pet-cloud-search__answer">{state.answer}</p>
								<p>已绑定 {state.citations.length} 条引用</p>
								<ol className="pet-cloud-search__citations">
									{state.citations.map((citation, index) => (
										<li key={citation.id}>
											{citation.kind === "wiki" ? "Wiki" : "原始资料"}{" "}
											{index + 1}：{citation.excerpt}
										</li>
									))}
								</ol>
							</>
						)}
					</div>
				</>
			)}
		</section>
	);
}
