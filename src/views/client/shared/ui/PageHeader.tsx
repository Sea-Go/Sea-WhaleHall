import type { ReactNode } from "react";

export interface PageHeaderProps {
	eyebrow: string;
	title: string;
	description: string;
	action?: ReactNode;
}

export function PageHeader({ eyebrow, title, description, action }: PageHeaderProps) {
	return (
		<header className="page-header">
			<div>
				<p className="page-header__eyebrow">{eyebrow}</p>
				<h1>{title}</h1>
				<p className="page-header__description">{description}</p>
			</div>
			{action ? <div className="page-header__action">{action}</div> : null}
		</header>
	);
}
