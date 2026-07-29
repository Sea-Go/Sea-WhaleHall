import { AlertTriangle } from "lucide-react";
import {
	useEffect,
	useRef,
	type KeyboardEvent,
	type RefObject,
} from "react";
import { Button } from "./Button";

export interface ConfirmationDialogProps {
	title: string;
	description: string;
	confirmLabel: string;
	cancelLabel?: string;
	busy?: boolean;
	onConfirm: () => void;
	onCancel: () => void;
	returnFocusRef?: RefObject<HTMLElement | null>;
}

export function ConfirmationDialog({
	title,
	description,
	confirmLabel,
	cancelLabel = "取消",
	busy = false,
	onConfirm,
	onCancel,
	returnFocusRef,
}: ConfirmationDialogProps) {
	const dialogRef = useRef<HTMLDivElement>(null);
	const cancelButtonRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		cancelButtonRef.current?.focus();
		return () => {
			window.requestAnimationFrame(() => returnFocusRef?.current?.focus());
		};
	}, [returnFocusRef]);

	function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (event.key === "Escape" && !busy) {
			event.preventDefault();
			onCancel();
			return;
		}
		if (event.key !== "Tab") return;
		const focusable = Array.from(
			dialogRef.current?.querySelectorAll<HTMLButtonElement>(
				"button:not(:disabled)",
			) ?? [],
		);
		const first = focusable[0];
		const last = focusable.at(-1);
		if (!first || !last) return;
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	}

	return (
		<div
			className="ui-dialog-backdrop"
			onPointerDown={(event) => {
				if (event.target === event.currentTarget && !busy) onCancel();
			}}
		>
			<div
				className="ui-confirmation-dialog"
				ref={dialogRef}
				role="alertdialog"
				aria-modal="true"
				aria-labelledby="confirmation-dialog-title"
				aria-describedby="confirmation-dialog-description"
				onKeyDown={handleKeyDown}
			>
				<span className="ui-confirmation-dialog__icon" aria-hidden="true">
					<AlertTriangle size={20} />
				</span>
				<div>
					<h2 id="confirmation-dialog-title">{title}</h2>
					<p id="confirmation-dialog-description">{description}</p>
				</div>
				<div className="ui-confirmation-dialog__actions">
					<Button
						ref={cancelButtonRef}
						variant="secondary"
						disabled={busy}
						onClick={onCancel}
					>
						{cancelLabel}
					</Button>
					<Button variant="danger" disabled={busy} onClick={onConfirm}>
						{busy ? "正在处理…" : confirmLabel}
					</Button>
				</div>
			</div>
		</div>
	);
}
