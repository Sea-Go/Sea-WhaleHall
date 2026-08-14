import {
	PROACTIVE_FEEDBACK_HISTORY_DEFAULT_LIMIT,
	type ProactiveFeedbackHistoryCursor,
	type ProactiveFeedbackItem,
	type ProactiveFeedbackPage,
} from "../../../../shared/proactive-feedback";
import {
	type ProactiveFeedbackService,
	proactiveFeedbackFailureMessage,
} from "./proactive-feedback-service";

interface HistoryData {
	items: readonly ProactiveFeedbackItem[];
	nextCursor: ProactiveFeedbackHistoryCursor | null;
}

export type ProactiveFeedbackHistoryState =
	| { status: "idle" }
	| { status: "loading" }
	| { status: "empty" }
	| ({ status: "ready" } & HistoryData)
	| ({ status: "loading-more" } & HistoryData)
	| ({
			status: "error";
			stage: "more";
			message: string;
			retryable: true;
	  } & HistoryData)
	| { status: "error"; stage: "initial"; message: string; retryable: true };

type Listener = () => void;

export class ProactiveFeedbackHistoryController {
	private state: ProactiveFeedbackHistoryState = { status: "idle" };
	private readonly listeners = new Set<Listener>();
	private request: Promise<unknown> | null = null;
	private visible = false;
	private stale = false;
	private stateVersion = 0;
	private readonly unsubscribeAvailable: () => void;

	constructor(private readonly service: ProactiveFeedbackService) {
		this.unsubscribeAvailable = service.onAvailable(() => {
			this.stale = true;
			if (this.visible) void this.load();
		});
	}

	readonly getSnapshot = (): ProactiveFeedbackHistoryState => this.state;
	readonly getServerSnapshot = (): ProactiveFeedbackHistoryState => this.state;
	readonly subscribe = (listener: Listener): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	setVisible(visible: boolean): void {
		this.visible = visible;
		if (visible && (this.state.status === "idle" || this.stale))
			void this.load();
	}

	load(): Promise<ProactiveFeedbackPage | null> {
		if (this.request)
			return this.request as Promise<ProactiveFeedbackPage | null>;
		this.stale = false;
		const version = ++this.stateVersion;
		this.setState({ status: "loading" });
		const request = this.performLoad(version);
		this.track(request);
		return request;
	}

	loadMore(): Promise<ProactiveFeedbackPage | null> {
		if (this.request || !hasHistory(this.state) || !this.state.nextCursor) {
			return Promise.resolve(null);
		}
		const current = historyData(this.state);
		const version = ++this.stateVersion;
		this.setState({ status: "loading-more", ...current });
		const request = this.performLoadMore(current, version);
		this.track(request);
		return request;
	}

	notifyCleared(): void {
		this.stateVersion += 1;
		this.stale = false;
		this.setState({ status: "empty" });
	}

	dispose(): void {
		this.stateVersion += 1;
		this.visible = false;
		this.unsubscribeAvailable();
		this.listeners.clear();
	}

	private async performLoad(
		version: number,
	): Promise<ProactiveFeedbackPage | null> {
		try {
			const page = await this.service.listHistory({
				limit: PROACTIVE_FEEDBACK_HISTORY_DEFAULT_LIMIT,
			});
			if (version !== this.stateVersion) return null;
			this.setState(
				page.items.length === 0
					? { status: "empty" }
					: {
							status: "ready",
							items: [...page.items],
							nextCursor: page.nextCursor,
						},
			);
			return page;
		} catch (reason) {
			if (version !== this.stateVersion) return null;
			this.setState({
				status: "error",
				stage: "initial",
				message: proactiveFeedbackFailureMessage(reason, "load-history"),
				retryable: true,
			});
			return null;
		}
	}

	private async performLoadMore(
		current: HistoryData,
		version: number,
	): Promise<ProactiveFeedbackPage | null> {
		try {
			const cursor = current.nextCursor;
			if (!cursor) return null;
			const page = await this.service.listHistory({
				cursor,
				limit: PROACTIVE_FEEDBACK_HISTORY_DEFAULT_LIMIT,
			});
			if (version !== this.stateVersion) return null;
			const seen = new Set(current.items.map((item) => item.id));
			const appended = page.items.filter((item) => !seen.has(item.id));
			this.setState({
				status: "ready",
				items: [...current.items, ...appended],
				nextCursor: page.nextCursor,
			});
			return page;
		} catch (reason) {
			if (version !== this.stateVersion) return null;
			this.setState({
				status: "error",
				stage: "more",
				message: proactiveFeedbackFailureMessage(reason, "load-history"),
				retryable: true,
				...current,
			});
			return null;
		}
	}

	private track<T>(request: Promise<T>): void {
		this.request = request;
		void request.finally(() => {
			if (this.request !== request) return;
			this.request = null;
			if (this.visible && this.stale) void this.load();
		});
	}

	private setState(state: ProactiveFeedbackHistoryState): void {
		this.state = state;
		for (const listener of this.listeners) listener();
	}
}

function hasHistory(
	state: ProactiveFeedbackHistoryState,
): state is Extract<ProactiveFeedbackHistoryState, HistoryData> {
	return "items" in state;
}

function historyData(
	state: Extract<ProactiveFeedbackHistoryState, HistoryData>,
): HistoryData {
	return { items: [...state.items], nextCursor: state.nextCursor };
}
