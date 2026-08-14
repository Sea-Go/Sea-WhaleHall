import { flushSync } from "react-dom";

/** Commits sensitive pet text removal before Bun receives its clear ACK. */
export function clearSensitivePetFeedbackSynchronously(
	clear: () => void,
): void {
	flushSync(clear);
}
