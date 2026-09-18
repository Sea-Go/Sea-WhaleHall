import type {
	CloudAcceptedAnswer,
	CloudAnswersPage,
	CloudHistoryResult,
	ListCloudAnswersRequest,
} from "../../../../shared/cloud-history";

export interface CloudHistoryService {
	list(
		input: ListCloudAnswersRequest,
	): Promise<CloudHistoryResult<CloudAnswersPage>>;
}

/** A product bridge must deliver this complete scope on every RTW session generation change. */
export interface CloudHistoryScope {
	logicalSessionId: string;
	productSessionId: string;
	generation: number;
}

export type CloudHistoryState =
	| { status: "disabled" }
	| { status: "loading" }
	| { status: "empty" }
	| {
			status: "ready" | "loading-more";
			items: readonly CloudAcceptedAnswer[];
			nextOrdinal: number | null;
	  }
	| {
			status: "error";
			reason: Exclude<CloudHistoryResult<never>["kind"], "ok">;
			items: readonly CloudAcceptedAnswer[];
			nextOrdinal: number | null;
	  };

type Listener = () => void;

/** Scoped to one approved RTW logical session; account cutover invalidates every outstanding page. */
export class CloudHistoryController {
	private state: CloudHistoryState = { status: "disabled" };
	private listeners = new Set<Listener>();
	private scope: CloudHistoryScope | null = null;
	private scopeKey: string | null = null;
	private version = 0;
	private visible = false;
	private pending = false;

	constructor(private readonly service: CloudHistoryService) {}

	readonly subscribe = (listener: Listener): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
	readonly getSnapshot = (): CloudHistoryState => this.state;
	readonly getServerSnapshot = (): CloudHistoryState => this.state;

	setScope(scope: CloudHistoryScope | null): void {
		if (
			scope &&
			(!scope.logicalSessionId ||
				!scope.productSessionId ||
				!Number.isSafeInteger(scope.generation))
		) {
			this.clear();
			return;
		}
		const key = scope
			? JSON.stringify([
					scope.productSessionId,
					scope.generation,
					scope.logicalSessionId,
				])
			: null;
		if (this.scopeKey === key) return;
		this.version++;
		this.scope = scope ? { ...scope } : null;
		this.scopeKey = key;
		this.pending = false;
		this.setState({ status: "disabled" });
		if (this.visible && scope) void this.load();
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		if (!visible) {
			this.version++;
			this.pending = false;
			this.setState({ status: "disabled" });
			return;
		}
		if (visible && this.scope) void this.load();
	}

	async load(): Promise<void> {
		const logicalSessionId = this.scope?.logicalSessionId;
		if (!logicalSessionId || this.pending) return;
		const version = ++this.version;
		this.pending = true;
		this.setState({ status: "loading" });
		try {
			const result = await this.service.list({
				logicalSessionId,
				afterOrdinal: 0,
				limit: 5,
			});
			if (version !== this.version) return;
			if (result.kind !== "ok") {
				this.setState(
					result.kind === "disabled"
						? { status: "disabled" }
						: {
								status: "error",
								reason: result.kind,
								items: [],
								nextOrdinal: null,
							},
				);
				return;
			}
			this.setState(
				result.data.items.length === 0
					? { status: "empty" }
					: {
							status: "ready",
							items: result.data.items,
							nextOrdinal: result.data.nextOrdinal,
						},
			);
		} catch {
			if (version === this.version)
				this.setState({
					status: "error",
					reason: "unavailable",
					items: [],
					nextOrdinal: null,
				});
		} finally {
			if (version === this.version) this.pending = false;
		}
	}

	async loadMore(): Promise<void> {
		if (
			this.pending ||
			!(["ready", "error"] as const).includes(
				this.state.status as "ready" | "error",
			) ||
			!("items" in this.state) ||
			!this.state.nextOrdinal ||
			!this.scope
		)
			return;
		const { nextOrdinal } = this.state;
		const items = withoutCurrentExcerpts(this.state.items);
		const logicalSessionId = this.scope.logicalSessionId;
		const version = ++this.version;
		this.pending = true;
		this.setState({ status: "loading-more", items, nextOrdinal });
		try {
			const result = await this.service.list({
				logicalSessionId,
				afterOrdinal: nextOrdinal,
				limit: 5,
			});
			if (version !== this.version) return;
			if (result.kind !== "ok") {
				this.setState(
					result.kind === "disabled"
						? { status: "disabled" }
						: {
								status: "error",
								reason: result.kind,
								items:
									result.kind === "signed_out" ||
									result.kind === "session_changed"
										? []
										: items,
								nextOrdinal:
									result.kind === "signed_out" ||
									result.kind === "session_changed"
										? null
										: nextOrdinal,
							},
				);
				return;
			}
			if (
				result.data.items.some(
					(answer) =>
						answer.acceptedOrdinal <= nextOrdinal ||
						items.some((old) => old.answerId === answer.answerId),
				)
			) {
				this.setState({
					status: "error",
					reason: "bad_response",
					items,
					nextOrdinal,
				});
				return;
			}
			this.setState({
				status: "ready",
				items: [...items, ...result.data.items],
				nextOrdinal: result.data.nextOrdinal,
			});
		} catch {
			if (version === this.version)
				this.setState({
					status: "error",
					reason: "unavailable",
					items,
					nextOrdinal,
				});
		} finally {
			if (version === this.version) this.pending = false;
		}
	}

	clear(): void {
		this.version++;
		this.scope = null;
		this.scopeKey = null;
		this.pending = false;
		this.setState({ status: "disabled" });
	}

	dispose(): void {
		this.clear();
		this.listeners.clear();
	}

	private setState(state: CloudHistoryState): void {
		this.state = state;
		for (const listener of this.listeners) listener();
	}
}

function withoutCurrentExcerpts(
	items: readonly CloudAcceptedAnswer[],
): CloudAcceptedAnswer[] {
	return items.map((item) => ({
		...item,
		citationState: "unavailable",
		citations: item.citations.map(({ excerpt: _excerpt, ...citation }) => ({
			...citation,
			state: "unavailable",
		})),
	}));
}
