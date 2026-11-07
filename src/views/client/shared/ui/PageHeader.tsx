import type { ReactNode } from "react";

export interface PageHeaderProps {
	eyebrow: string;
	title: string;
	/** 页头副标题；省略时不渲染该行。 */
	description?: string;
	action?: ReactNode;
}

export function PageHeader({
	eyebrow,
	title,
	description,
	action,
}: PageHeaderProps) {
	return (
		<header className="page-header">
			<div>
				<p className="page-header__eyebrow">{eyebrow}</p>
				<h1>{title}</h1>
				{description ? (
					<p className="page-header__description">{description}</p>
				) : null}
			</div>
			{action ? <div className="page-header__action">{action}</div> : null}
		</header>
	);
}
