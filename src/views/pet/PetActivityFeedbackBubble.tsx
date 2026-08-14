import { useEffect, useRef, useState } from "react";
import {
	type PetActivityFeedbackPage,
	PetActivityFeedbackQueue,
} from "./activity-feedback";
import { PetActivityFeedbackBubbleView } from "./PetActivityFeedbackBubbleView";
import { petApi } from "./rpc";
import { clearSensitivePetFeedbackSynchronously } from "./sensitive-feedback-clear";

export function PetActivityFeedbackBubble() {
	const [page, setPage] = useState<PetActivityFeedbackPage | null>(null);
	const queueRef = useRef<PetActivityFeedbackQueue | null>(null);

	useEffect(() => {
		const queue = new PetActivityFeedbackQueue({
			onPage: setPage,
			initiallyPresent: !document.hidden,
		});
		queueRef.current = queue;
		const unsubscribePresentation = petApi.onActivityFeedback(
			(presentation) => {
				queue.enqueue(presentation);
			},
		);
		const unsubscribeClear = petApi.onActivityFeedbackClear(() => {
			// The Bun RPC clear response is an account-transition barrier. Commit the
			// DOM removal before its handler returns so the ACK proves no old-account
			// text remains visible or accessible.
			clearSensitivePetFeedbackSynchronously(() => queue.clear());
		});
		const handleVisibility = () => {
			queue.setPresent(!document.hidden);
		};
		document.addEventListener("visibilitychange", handleVisibility);
		handleVisibility();
		return () => {
			document.removeEventListener("visibilitychange", handleVisibility);
			unsubscribePresentation();
			unsubscribeClear();
			if (queueRef.current === queue) queueRef.current = null;
			queue.dispose();
		};
	}, []);

	return (
		<PetActivityFeedbackBubbleView
			page={page}
			onNext={() => queueRef.current?.next()}
			onDismiss={() => queueRef.current?.dismissCurrent()}
		/>
	);
}
