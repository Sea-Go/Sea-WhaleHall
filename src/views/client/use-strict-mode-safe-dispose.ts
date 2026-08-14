import { useEffect, useRef } from "react";

type PendingDisposal<Resource extends object> = {
	resource: Resource;
	cancelled: boolean;
};

/**
 * Defers disposal for one microtask so React StrictMode's setup-cleanup-setup
 * rehearsal can reclaim the same resource. A genuinely replaced resource is
 * still disposed because only an immediate setup for that exact identity may
 * cancel its pending cleanup.
 */
export function useStrictModeSafeDispose<Resource extends object>(
	resource: Resource,
	dispose: (resource: Resource) => void,
): void {
	const pendingRef = useRef<PendingDisposal<Resource> | null>(null);
	const disposeRef = useRef(dispose);
	disposeRef.current = dispose;

	useEffect(() => {
		const pending = pendingRef.current;
		if (pending?.resource === resource) {
			pending.cancelled = true;
			pendingRef.current = null;
		}

		return () => {
			const cleanup: PendingDisposal<Resource> = {
				resource,
				cancelled: false,
			};
			pendingRef.current = cleanup;
			queueMicrotask(() => {
				if (!cleanup.cancelled) disposeRef.current(cleanup.resource);
				if (pendingRef.current === cleanup) pendingRef.current = null;
			});
		};
	}, [resource]);
}
