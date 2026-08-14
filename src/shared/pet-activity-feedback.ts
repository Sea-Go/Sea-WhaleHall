import type { RPCSchema } from "electrobun/bun";
import type { PetRPC as ExistingPetRPC } from "./contracts";
import {
	PROACTIVE_FEEDBACK_MESSAGE_MAX_BYTES,
	PROACTIVE_FEEDBACK_MESSAGE_MAX_CHARACTERS,
} from "./proactive-feedback";

export const MAX_PET_ACTIVITY_FEEDBACK_BYTES =
	PROACTIVE_FEEDBACK_MESSAGE_MAX_BYTES;
export const MAX_PET_ACTIVITY_FEEDBACK_CHARACTERS =
	PROACTIVE_FEEDBACK_MESSAGE_MAX_CHARACTERS;
export const MAX_PET_ACTIVITY_FEEDBACK_PRESENTATION_ID_CHARACTERS = 256;

/**
 * Sensitive Agent output that may travel only from Bun to the dedicated pet
 * WebView. Account identity and source activity never belong in this payload.
 */
export type PetActivityFeedbackPresentation = {
	presentationId: string;
	generatedAtMs: number;
	text: string;
};

export type PetActivityFeedbackClearRequest = {
	clearId: string;
};

export type PetActivityFeedbackClearResponse = {
	clearId: string;
	cleared: true;
};

export type PetActivityFeedbackRendererReady = {
	rendererEpoch: string;
};

export type PetActivityFeedbackRendererChallenge =
	PetActivityFeedbackRendererReady;

function hasDisallowedTextControl(text: string): boolean {
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		if (
			code <= 8 ||
			code === 11 ||
			code === 12 ||
			code === 13 ||
			(code >= 14 && code <= 31) ||
			(code >= 127 && code <= 159)
		) {
			return true;
		}
	}
	return false;
}

function utf8ByteLength(text: string): number {
	return new TextEncoder().encode(text).byteLength;
}

export function isPetActivityFeedbackPresentation(
	value: unknown,
): value is PetActivityFeedbackPresentation {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	if (
		keys.length !== 3 ||
		keys[0] !== "generatedAtMs" ||
		keys[1] !== "presentationId" ||
		keys[2] !== "text"
	) {
		return false;
	}
	return (
		typeof record.presentationId === "string" &&
		record.presentationId.trim().length > 0 &&
		record.presentationId.length <=
			MAX_PET_ACTIVITY_FEEDBACK_PRESENTATION_ID_CHARACTERS &&
		typeof record.generatedAtMs === "number" &&
		Number.isSafeInteger(record.generatedAtMs) &&
		record.generatedAtMs >= 0 &&
		typeof record.text === "string" &&
		record.text.trim().length > 0 &&
		record.text.length <= MAX_PET_ACTIVITY_FEEDBACK_CHARACTERS &&
		utf8ByteLength(record.text) <= MAX_PET_ACTIVITY_FEEDBACK_BYTES &&
		!hasDisallowedTextControl(record.text)
	);
}

export function isPetActivityFeedbackClearResponse(
	value: unknown,
	expectedClearId: string,
): value is PetActivityFeedbackClearResponse {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	return (
		keys.length === 2 &&
		keys[0] === "clearId" &&
		keys[1] === "cleared" &&
		record.clearId === expectedClearId &&
		record.cleared === true
	);
}

export function isPetActivityFeedbackRendererReady(
	value: unknown,
): value is PetActivityFeedbackRendererReady {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	return (
		keys.length === 1 &&
		keys[0] === "rendererEpoch" &&
		typeof record.rendererEpoch === "string" &&
		record.rendererEpoch.length > 0 &&
		record.rendererEpoch.length <= 128
	);
}

/**
 * Pet RPC augmented at its Bun-to-WebView edge without broadening the legacy
 * content-free Client PetPresentationEvent contract.
 */
export type PetActivityFeedbackRPC = {
	bun: RPCSchema<{
		requests: ExistingPetRPC["bun"]["requests"];
		messages: ExistingPetRPC["bun"]["messages"];
	}>;
	webview: RPCSchema<{
		requests: ExistingPetRPC["webview"]["requests"] & {
			clearActivityFeedback: {
				params: PetActivityFeedbackClearRequest;
				response: PetActivityFeedbackClearResponse;
			};
			proveActivityFeedbackRenderer: {
				params: PetActivityFeedbackRendererChallenge;
				response: PetActivityFeedbackRendererReady;
			};
		};
		messages: ExistingPetRPC["webview"]["messages"] & {
			presentActivityFeedback: PetActivityFeedbackPresentation;
		};
	}>;
};
