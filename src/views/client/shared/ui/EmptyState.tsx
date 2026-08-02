import type { ReactNode } from "react";

export interface EmptyStateProps {
	icon: ReactNode;
	eyebrow?: string;
	title: string;
	description: string;
	action?: ReactNode;
	className?: string;
}

export function EmptyState({
	icon,
	eyebrow,
	title,
	description,
	action,
	className,
}: EmptyStateProps) {
	return (
		<div className={["empty-state", className].filter(Boolean).join(" ")}>
			<div className="empty-state__icon" aria-hidden="true">
				{icon}
			</div>
			{eyebrow ? <p className="empty-state__eyebrow">{eyebrow}</p> : null}
			<h2>{title}</h2>
			<p>{description}</p>
			{action ? <div className="empty-state__action">{action}</div> : null}
		</div>
	);
}
