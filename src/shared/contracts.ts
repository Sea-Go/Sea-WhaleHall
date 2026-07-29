import type { RPCSchema } from 'electrobun/bun';
import type { PetActionId } from './pet-actions';
import type { PetPresentationEvent } from './pet-presentation';
import type { ActiveGoalContextV1 } from './goal-context';
import type {
	LocalRuntimeStatus,
	LocalToolCall,
	LocalToolCallResult,
	LocalToolCancelResult,
	LocalToolDescriptor,
	LocalToolEvent,
} from '../agent/local-protocol';

export type {
	LocalRuntimeStatus,
	LocalToolCall,
	LocalToolCallResult,
	LocalToolCancelResult,
	LocalToolDescriptor,
	LocalToolEvent,
	PetPresentationEvent,
	ActiveGoalContextV1,
};

export type PetMood = 'idle' | 'happy' | 'busy' | 'error';

/** Canonical, model-independent action identifier shared by every pet surface. */
export type PetAnimationId = PetActionId;

export type PetState = {
	mood: PetMood;
	message: string;
	action?: PetAnimationId;
	/** Registry id resolved by the renderer; unknown ids safely fall back to whale. */
	modelId?: string;
	environment?: {
		weather?: 'clear' | 'cloudy' | 'rain' | 'snow';
		temperatureC?: number;
		holiday?: string;
		/** Local calendar day in MM-DD form. */
		birthday?: string;
	};
	/** @deprecated Use action. Kept while older renderer/backend callers migrate. */
	animation?: PetAnimationId;
};

export type PetInteractionMessage = {
	kind:
		| 'hover'
		| 'hoverEnd'
		| 'click'
		| 'doubleClick'
		| 'rapidClick'
		| 'pet'
		| 'petEnd'
		| 'poke'
		| 'dragStart'
		| 'dragEnd';
	action: PetAnimationId;
	modelId: string;
	zone?: 'head' | 'face' | 'body' | 'tail' | 'limb' | null;
	pointerId?: number;
	dragDelta?: { x: number; y: number };
};

export type NativePetDragState = {
	dragging: boolean;
	reason?: 'pointerup' | 'webview' | 'hidden' | 'disposed';
};

export type ClientRPC = {
	bun: RPCSchema<{
		requests: {
			getLocalStatus: {
				params: Record<string, never>;
				response: LocalRuntimeStatus;
			};
			listLocalTools: {
				params: Record<string, never>;
				response: { tools: LocalToolDescriptor[] };
			};
			callLocalTool: {
				params: LocalToolCall;
				response: LocalToolCallResult;
			};
			cancelLocalTool: {
				params: { callId: string };
				response: LocalToolCancelResult;
			};
			setPetVisible: {
				params: { visible: boolean };
				response: { visible: boolean };
			};
			presentPetEvent: {
				params: PetPresentationEvent;
				response: { accepted: boolean };
			};
			setActiveGoalContext: {
				params: { goal: ActiveGoalContextV1 | null };
				response: { goal: ActiveGoalContextV1 | null };
			};
		};
		messages: Record<never, never>;
	}>;
	webview: RPCSchema<{
		requests: Record<never, never>;
		messages: {
			localStatusChanged: LocalRuntimeStatus;
			localToolEvent: LocalToolEvent;
			petVisibilityChanged: { visible: boolean };
		};
	}>;
};

export type PetRPC = {
	bun: RPCSchema<{
		requests: Record<never, never>;
		messages: {
			ready: void;
			interacted: PetInteractionMessage;
		};
	}>;
	webview: RPCSchema<{
		requests: Record<never, never>;
		messages: {
			setPetState: PetState;
			nativeDragChanged: NativePetDragState;
		};
	}>;
};
