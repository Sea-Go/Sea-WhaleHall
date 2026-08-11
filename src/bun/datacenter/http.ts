export type DataCenterHttpErrorKind = "offline" | "timeout" | "http";

export class DataCenterHttpError extends Error {
	readonly kind: DataCenterHttpErrorKind;
	readonly status: number | null;
	readonly serverMessage: string;

	constructor(
		kind: DataCenterHttpErrorKind,
		status: number | null,
		message: string,
		serverMessage = "",
	) {
		super(message);
		this.name = "DataCenterHttpError";
		this.kind = kind;
		this.status = status;
		this.serverMessage = serverMessage;
	}
}

export type DataCenterFetch = (
	url: string,
	init: RequestInit,
) => Promise<Response>;

export type DataCenterHttpClientOptions = {
	baseUrl: string;
	fetch?: DataCenterFetch;
	timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 15_000;

export type RequestOptions = {
	headers?: Record<string, string>;
	bearer?: string;
	body?: unknown;
};

export class DataCenterHttpClient {
	private readonly baseUrl: string;
	private readonly fetchImpl: DataCenterFetch;
	private readonly timeoutMs: number;

	constructor(options: DataCenterHttpClientOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
		this.fetchImpl = options.fetch ?? fetch;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	async post<T>(
		path: string,
		body: unknown,
		options: RequestOptions = {},
	): Promise<T> {
		return this.request<T>("POST", path, { ...options, body });
	}

	async get<T>(path: string, options: RequestOptions = {}): Promise<T> {
		return this.request<T>("GET", path, options);
	}

	async put<T>(
		path: string,
		body: unknown,
		options: RequestOptions = {},
	): Promise<T> {
		return this.request<T>("PUT", path, { ...options, body });
	}

	async delete<T>(
		path: string,
		options: RequestOptions = {},
	): Promise<T> {
		return this.request<T>("DELETE", path, options);
	}

	private async request<T>(
		method: string,
		path: string,
		options: RequestOptions,
	): Promise<T> {
		const url = this.baseUrl + normalizePath(path);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		const headers: Record<string, string> = { ...options.headers };
		if (options.bearer !== undefined) {
			headers.authorization = `Bearer ${options.bearer}`;
		}
		if (options.body !== undefined) {
			headers["content-type"] = "application/json";
		}
		try {
			let response: Response;
			try {
				response = await this.fetchImpl(url, {
					method,
					headers,
					body:
						options.body === undefined
							? undefined
							: JSON.stringify(options.body),
					signal: controller.signal,
				});
			} catch {
				throw new DataCenterHttpError(
					controller.signal.aborted ? "timeout" : "offline",
					null,
					controller.signal.aborted
						? "DataCenter request timed out."
						: "DataCenter is unreachable.",
				);
			} finally {
				clearTimeout(timer);
			}
			if (!response.ok) {
				throw new DataCenterHttpError(
					"http",
					response.status,
					`DataCenter request failed with HTTP ${response.status}.`,
					await readServerMessage(response),
				);
			}
			if (response.status === 204) {
				return undefined as T;
			}
			return (await response.json()) as T;
		} finally {
			clearTimeout(timer);
		}
	}
}

async function readServerMessage(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as { error?: unknown };
		return typeof body.error === "string" ? body.error : "";
	} catch {
		return "";
	}
}

function normalizePath(path: string): string {
	if (path.length === 0 || path.startsWith("/")) return path;
	return "/" + path;
}
