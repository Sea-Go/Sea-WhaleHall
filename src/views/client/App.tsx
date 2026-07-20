import { useEffect, useMemo, useState } from "react";
import type {
	LocalRuntimeStatus,
	LocalToolDescriptor,
	LocalToolEvent,
} from "../../shared/contracts";
import { clientApi } from "./rpc";

const initialStatus: LocalRuntimeStatus = {
	state: "starting",
	pid: null,
	activeCalls: 0,
	lastError: null,
};

export function App() {
	const [status, setStatus] = useState(initialStatus);
	const [petVisible, setPetVisible] = useState(true);
	const [tools, setTools] = useState<LocalToolDescriptor[]>([]);
	const [selectedName, setSelectedName] = useState("system.info");
	const [argumentsText, setArgumentsText] = useState("{}");
	const [result, setResult] = useState("No local tool has run yet.");
	const [events, setEvents] = useState<LocalToolEvent[]>([]);
	const [progress, setProgress] = useState(0);
	const [activeCallId, setActiveCallId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<"catalog" | "tool" | "cancel" | "pet" | null>(null);

	const selectedTool = useMemo(
		() => tools.find((tool) => tool.name === selectedName) ?? null,
		[tools, selectedName],
	);

	useEffect(() => {
		let active = true;
		const offStatus = clientApi.onStatus((next) => active && setStatus(next));
		const offToolEvent = clientApi.onToolEvent((event) => {
			if (!active) return;
			setEvents((current) => [...current.slice(-11), event]);
			if (event.event === "tool.started") setProgress(0);
			if (event.event === "tool.progress" && typeof event.data.progress === "number") {
				setProgress(event.data.progress);
			}
			if (
				event.event === "tool.completed" ||
				event.event === "tool.failed" ||
				event.event === "tool.cancelled"
			) {
				setActiveCallId((callId) => (callId === event.callId ? null : callId));
			}
		});
		const offVisibility = clientApi.onPetVisibility(
			(visible) => active && setPetVisible(visible),
		);

		void clientApi
			.getLocalStatus()
			.then((next) => active && setStatus(next))
			.catch((reason: unknown) => active && setError(errorMessage(reason)));
		void loadTools(active, setTools, setSelectedName, setArgumentsText, setError);
		return () => {
			active = false;
			offStatus();
			offToolEvent();
			offVisibility();
		};
	}, []);

	async function refreshTools() {
		setBusy("catalog");
		setError(null);
		try {
			const response = await clientApi.listLocalTools();
			setTools(response.tools);
			if (!response.tools.some((tool) => tool.name === selectedName)) {
				const first = response.tools[0];
				if (first) selectTool(first.name);
			}
		} catch (reason) {
			setError(errorMessage(reason));
		} finally {
			setBusy(null);
		}
	}

	function selectTool(name: string) {
		setSelectedName(name);
		setArgumentsText(defaultArguments(name));
		setProgress(0);
		setError(null);
	}

	async function runTool() {
		if (!selectedTool) return;
		let args: unknown;
		try {
			args = JSON.parse(argumentsText);
		} catch (reason) {
			setError(`Arguments must be valid JSON: ${errorMessage(reason)}`);
			return;
		}
		if (!isRecord(args)) {
			setError("Arguments must be a JSON object.");
			return;
		}

		const callId = crypto.randomUUID();
		setActiveCallId(callId);
		setBusy("tool");
		setProgress(0);
		setError(null);
		setResult("Waiting for whalehall-local…");
		try {
			const response = await clientApi.callLocalTool({
				callId,
				name: selectedTool.name,
				arguments: args,
			});
			setResult(JSON.stringify(response.output, null, 2));
		} catch (reason) {
			setError(errorMessage(reason));
		} finally {
			setActiveCallId((current) => (current === callId ? null : current));
			setBusy(null);
		}
	}

	async function cancelTool() {
		if (!activeCallId) return;
		setBusy("cancel");
		setError(null);
		try {
			const response = await clientApi.cancelLocalTool(activeCallId);
			if (!response.cancelled) setError("The local call already finished or was not found.");
		} catch (reason) {
			setError(errorMessage(reason));
		} finally {
			setBusy("tool");
		}
	}

	async function togglePet() {
		setBusy("pet");
		setError(null);
		try {
			const response = await clientApi.setPetVisible(!petVisible);
			setPetVisible(response.visible);
		} catch (reason) {
			setError(errorMessage(reason));
		} finally {
			setBusy(null);
		}
	}

	return (
		<main className="shell">
			<header className="hero">
				<div>
					<p className="eyebrow">SEA · WHALEHALL · LOCAL</p>
					<h1>Local tool control room</h1>
					<p className="lede">
						The TypeScript Agent stays thin while Rust owns safe, typed access to this host.
					</p>
				</div>
				<div className={`status status--${status.state}`}>
					<span className="status__dot" />
					<div>
						<strong>{status.state}</strong>
						<small>
							{status.pid ? `Local PID ${status.pid}` : "No local process"}
							{status.activeCalls > 0 ? ` · ${status.activeCalls} active` : ""}
						</small>
					</div>
				</div>
			</header>

			{error ? <div className="alert">{error}</div> : null}

			<section className="grid">
				<article className="card card--wide">
					<div className="card__heading">
						<div>
							<span className="card__index">01</span>
							<h2>Local tool catalog</h2>
						</div>
						<button className="secondary" onClick={refreshTools} disabled={busy !== null}>
							{busy === "catalog" ? "Refreshing…" : "Refresh"}
						</button>
					</div>
					<div className="tool-list">
						{tools.map((tool) => (
							<button
								className={`tool-chip ${tool.name === selectedName ? "tool-chip--active" : ""}`}
								key={tool.name}
								onClick={() => selectTool(tool.name)}
								disabled={activeCallId !== null}
							>
								<strong>{tool.name}</strong>
								<small>{tool.risk}</small>
							</button>
						))}
					</div>
				</article>

				<article className="card card--wide">
					<div className="card__heading">
						<div>
							<span className="card__index">02</span>
							<h2>{selectedTool?.name ?? "Select a local tool"}</h2>
						</div>
						<div className="badges">
							<span>{selectedTool?.risk ?? "—"}</span>
							<span>{selectedTool?.supportsCancellation ? "cancellable" : "atomic"}</span>
						</div>
					</div>
					<p>{selectedTool?.description ?? "The Rust tool catalog is unavailable."}</p>
					<p className="permissions">
						Permissions: {selectedTool?.requiredPermissions.join(", ") || "none"}
					</p>
					<label htmlFor="tool-arguments">JSON arguments</label>
					<textarea
						id="tool-arguments"
						value={argumentsText}
						onChange={(event) => setArgumentsText(event.target.value)}
						disabled={activeCallId !== null}
						spellCheck={false}
					/>
					<div className="action-row">
						<button onClick={runTool} disabled={!selectedTool || activeCallId !== null}>
							{activeCallId ? "Running…" : "Run local tool"}
						</button>
						{activeCallId && selectedTool?.supportsCancellation ? (
							<button className="danger" onClick={cancelTool} disabled={busy === "cancel"}>
								{busy === "cancel" ? "Cancelling…" : "Cancel"}
							</button>
						) : null}
						<span className="progress-label">{activeCallId ? `${progress}%` : "idle"}</span>
					</div>
					<div className="progress-track">
						<span style={{ width: `${progress}%` }} />
					</div>
					<pre className="output">{result}</pre>
				</article>

				<article className="card">
					<span className="card__index">03</span>
					<h2>Tool events</h2>
					<div className="event-list">
						{events.length === 0 ? <p>No events yet.</p> : null}
						{events.slice(-5).map((event, index) => (
							<div className="event" key={`${event.callId}-${event.event}-${index}`}>
								<strong>{event.event}</strong>
								<small>{event.callId.slice(0, 8)}</small>
							</div>
						))}
					</div>
				</article>

				<article className="card">
					<span className="card__index">04</span>
					<h2>Desktop companion</h2>
					<p>The whale reflects Local Tool activity without owning host permissions.</p>
					<button className="secondary" onClick={togglePet} disabled={busy !== null}>
						{petVisible ? "Hide whale" : "Show whale"}
					</button>
					<p className="mono">{status.lastError ?? "No Local Tool Host errors recorded."}</p>
				</article>
			</section>
		</main>
	);
}

async function loadTools(
	active: boolean,
	setTools: (tools: LocalToolDescriptor[]) => void,
	setSelectedName: (name: string) => void,
	setArgumentsText: (value: string) => void,
	setError: (error: string) => void,
) {
	try {
		const response = await clientApi.listLocalTools();
		if (!active) return;
		setTools(response.tools);
		const preferred = response.tools.find((tool) => tool.name === "system.info") ?? response.tools[0];
		if (preferred) {
			setSelectedName(preferred.name);
			setArgumentsText(defaultArguments(preferred.name));
		}
	} catch (reason) {
		if (active) setError(errorMessage(reason));
	}
}

function defaultArguments(name: string): string {
	return name === "demo.wait" ? '{\n  "durationMs": 1500\n}' : "{}";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(reason: unknown): string {
	return reason instanceof Error ? reason.message : String(reason);
}
