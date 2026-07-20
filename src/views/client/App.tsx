import { useEffect, useState } from "react";
import type { RuntimeStatus } from "../../shared/contracts";
import type { EchoResult, HealthResult } from "../../shared/protocol";
import { MAX_ECHO_CHARACTERS } from "../../shared/protocol";
import { clientApi } from "./rpc";

const initialStatus: RuntimeStatus = {
	state: "starting",
	pid: null,
	lastError: null,
};

export function App() {
	const [status, setStatus] = useState(initialStatus);
	const [petVisible, setPetVisible] = useState(true);
	const [health, setHealth] = useState<HealthResult | null>(null);
	const [message, setMessage] = useState("Hello from the React client");
	const [echo, setEcho] = useState<EchoResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<"health" | "echo" | "pet" | null>(null);

	useEffect(() => {
		let active = true;
		const offStatus = clientApi.onStatus((next) => active && setStatus(next));
		const offVisibility = clientApi.onPetVisibility(
			(visible) => active && setPetVisible(visible),
		);
		void clientApi
			.getRuntimeStatus()
			.then((next) => active && setStatus(next))
			.catch((reason: unknown) => active && setError(errorMessage(reason)));
		return () => {
			active = false;
			offStatus();
			offVisibility();
		};
	}, []);

	async function checkHealth() {
		setBusy("health");
		setError(null);
		try {
			setHealth(await clientApi.healthCheck());
		} catch (reason) {
			setError(errorMessage(reason));
		} finally {
			setBusy(null);
		}
	}

	async function sendEcho() {
		setBusy("echo");
		setError(null);
		try {
			setEcho(await clientApi.echo(message));
		} catch (reason) {
			setError(errorMessage(reason));
		} finally {
			setBusy(null);
		}
	}

	async function togglePet() {
		setBusy("pet");
		setError(null);
		try {
			const result = await clientApi.setPetVisible(!petVisible);
			setPetVisible(result.visible);
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
					<p className="eyebrow">SEA · WHALEHALL</p>
					<h1>Agent bridge control room</h1>
					<p className="lede">
						React, Electrobun Typed RPC, Bun and Rust are connected as one local pipeline.
					</p>
				</div>
				<div className={`status status--${status.state}`}>
					<span className="status__dot" />
					<div>
						<strong>{status.state}</strong>
						<small>{status.pid ? `Rust PID ${status.pid}` : "No native process"}</small>
					</div>
				</div>
			</header>

			{error ? <div className="alert">{error}</div> : null}

			<section className="grid">
				<article className="card card--wide">
					<div className="card__heading">
						<div>
							<span className="card__index">01</span>
							<h2>Native health</h2>
						</div>
						<button onClick={checkHealth} disabled={busy !== null}>
							{busy === "health" ? "Checking…" : "Run health.check"}
						</button>
					</div>
					<div className="result">
						<span>service</span><code>{health?.service ?? "—"}</code>
						<span>version</span><code>{health?.version ?? "—"}</code>
						<span>status</span><code>{health?.status ?? "waiting"}</code>
					</div>
				</article>

				<article className="card card--wide">
					<div className="card__heading">
						<div>
							<span className="card__index">02</span>
							<h2>JSONL echo</h2>
						</div>
					</div>
					<label htmlFor="echo-message">Message sent through stdin/stdout</label>
					<div className="input-row">
						<input
							id="echo-message"
							value={message}
							maxLength={MAX_ECHO_CHARACTERS}
							onChange={(event) => setMessage(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") void sendEcho();
							}}
						/>
						<button onClick={sendEcho} disabled={busy !== null}>
							{busy === "echo" ? "Sending…" : "Send"}
						</button>
					</div>
					<blockquote>{echo?.message ?? "The Rust response will appear here."}</blockquote>
				</article>

				<article className="card">
					<span className="card__index">03</span>
					<h2>Desktop companion</h2>
					<p>The transparent Canvas whale is isolated in its own WebView.</p>
					<button className="secondary" onClick={togglePet} disabled={busy !== null}>
						{petVisible ? "Hide whale" : "Show whale"}
					</button>
				</article>

				<article className="card">
					<span className="card__index">04</span>
					<h2>Failure state</h2>
					<p className="mono">{status.lastError ?? "No bridge errors recorded."}</p>
				</article>
			</section>
		</main>
	);
}

function errorMessage(reason: unknown): string {
	return reason instanceof Error ? reason.message : String(reason);
}
