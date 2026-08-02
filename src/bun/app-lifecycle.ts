export interface BackgroundWindow {
	activate(): unknown;
	show(): unknown;
}

export interface BackgroundAppLifecycleOptions<
	WindowType extends BackgroundWindow,
> {
	createWindow(): Promise<WindowType>;
	shutdown(): Promise<void>;
	exit(): void;
	onError?(operation: "open" | "quit", error: unknown): void;
}

/**
 * Keeps the native monitoring runtime alive when the control window closes.
 *
 * The window is presentation state. Explicit application quit is the only
 * transition that tears down Timeline, whalehall-local, and Observer.
 */
export class BackgroundAppLifecycle<WindowType extends BackgroundWindow> {
	private window: WindowType | null = null;
	private opening: Promise<WindowType> | null = null;
	private quitting: Promise<void> | null = null;

	constructor(
		private readonly options: BackgroundAppLifecycleOptions<WindowType>,
	) {}

	get currentWindow(): WindowType | null {
		return this.window;
	}

	open(): Promise<WindowType> {
		if (this.window !== null) {
			this.window.show();
			this.window.activate();
			return Promise.resolve(this.window);
		}
		if (this.opening !== null) return this.opening;

		const opening = this.options
			.createWindow()
			.then((window) => {
				if (this.quitting !== null) {
					throw new Error(
						"Cannot attach a control window while WhaleHall is quitting.",
					);
				}
				this.window = window;
				return window;
			})
			.catch((error) => {
				this.options.onError?.("open", error);
				throw error;
			})
			.finally(() => {
				if (this.opening === opening) this.opening = null;
			});
		this.opening = opening;
		return opening;
	}

	didClose(window: WindowType): void {
		if (this.window === window) this.window = null;
	}

	quit(): Promise<void> {
		if (this.quitting !== null) return this.quitting;
		const quitting = (async () => {
			try {
				await this.opening?.catch(() => undefined);
				await this.options.shutdown();
			} catch (error) {
				this.options.onError?.("quit", error);
			} finally {
				this.options.exit();
			}
		})();
		this.quitting = quitting;
		return quitting;
	}
}
