/**
 * 桌宠状态真源:可见性/呈现/当前包/当前动作的单一归属(标准 §2.6)。
 * 视图订阅推送并回执,修 boot 期 transport 丢推送。
 */

export interface PetStateSnapshot {
	visible: boolean;
	petId: string;
	actionId: string;
}

export interface PetStateStoreOptions {
	initial: PetStateSnapshot;
	onChange: (snapshot: PetStateSnapshot) => void;
}

export class PetStateStore {
	private snapshot: PetStateSnapshot;
	private readonly onChange: (snapshot: PetStateSnapshot) => void;

	constructor(options: PetStateStoreOptions) {
		this.snapshot = options.initial;
		this.onChange = options.onChange;
	}

	get(): PetStateSnapshot {
		return this.snapshot;
	}

	setVisible(visible: boolean): void {
		if (this.snapshot.visible === visible) return;
		this.snapshot = { ...this.snapshot, visible };
		this.onChange(this.snapshot);
	}

	setPetId(petId: string): void {
		if (this.snapshot.petId === petId) return;
		this.snapshot = { ...this.snapshot, petId };
		this.onChange(this.snapshot);
	}

	setActionId(actionId: string): void {
		if (this.snapshot.actionId === actionId) return;
		this.snapshot = { ...this.snapshot, actionId };
		this.onChange(this.snapshot);
	}
}
