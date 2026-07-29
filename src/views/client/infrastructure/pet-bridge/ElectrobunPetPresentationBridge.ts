import type {
	PetBridgeDiagnosticLogger,
	PetPresentationBridge,
	PetPresentationEvent,
} from "../../features/pet-bridge/public";

export interface PetBridgeTransport {
	present(event: PetPresentationEvent): Promise<void>;
	setVisible(visible: boolean): Promise<void>;
}

export interface ElectrobunPetPresentationBridgeOptions {
	loadTransport?: () => Promise<PetBridgeTransport>;
	runtimeAvailable?: () => boolean;
	logger?: PetBridgeDiagnosticLogger;
}

const defaultLogger: PetBridgeDiagnosticLogger = {
	warn(message, context) {
		console.warn(message, context);
	},
};

export class ElectrobunPetPresentationBridge
	implements PetPresentationBridge
{
	private readonly loadTransport: () => Promise<PetBridgeTransport>;
	private readonly runtimeAvailable: () => boolean;
	private readonly logger: PetBridgeDiagnosticLogger;

	constructor(options: ElectrobunPetPresentationBridgeOptions = {}) {
		this.loadTransport = options.loadTransport ?? loadClientTransport;
		this.runtimeAvailable = options.runtimeAvailable ?? hasElectrobunRuntime;
		this.logger = options.logger ?? defaultLogger;
	}

	async present(event: PetPresentationEvent): Promise<void> {
		if (!this.runtimeAvailable()) return;
		try {
			const transport = await this.loadTransport();
			await transport.present(event);
		} catch {
			this.logger.warn("[pet-bridge] presentation delivery failed", {
				operation: "present",
				eventKind: event.kind,
				category: "transport",
			});
		}
	}

	async setVisible(visible: boolean): Promise<void> {
		if (!this.runtimeAvailable()) return;
		try {
			const transport = await this.loadTransport();
			await transport.setVisible(visible);
		} catch {
			this.logger.warn("[pet-bridge] visibility delivery failed", {
				operation: "set-visible",
				category: "transport",
			});
		}
	}
}

async function loadClientTransport(): Promise<PetBridgeTransport> {
	const { clientApi } = await import("../../rpc");
	return {
		async present(event) {
			await clientApi.presentPetEvent(event);
		},
		async setVisible(visible) {
			await clientApi.setPetVisible(visible);
		},
	};
}

function hasElectrobunRuntime(): boolean {
	return (
		typeof window !== "undefined" &&
		"__electrobun" in window &&
		"__electrobunBunBridge" in window
	);
}
