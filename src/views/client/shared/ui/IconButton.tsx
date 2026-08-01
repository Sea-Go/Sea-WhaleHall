import type { ButtonHTMLAttributes, ReactNode } from "react";

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	label: string;
	icon: ReactNode;
}

export function IconButton({
	label,
	icon,
	className,
	type = "button",
	...props
}: IconButtonProps) {
	return (
		<button
			className={["ui-icon-button", className].filter(Boolean).join(" ")}
			type={type}
			aria-label={label}
			title={label}
			{...props}
		>
			{icon}
		</button>
	);
}
