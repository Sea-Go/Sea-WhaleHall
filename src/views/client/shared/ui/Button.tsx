import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "small" | "medium";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: ButtonVariant;
	size?: ButtonSize;
	icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
	{
		variant = "secondary",
		size = "medium",
		icon,
		className,
		children,
		type = "button",
		...props
	},
	ref,
) {
	return (
		<button
			ref={ref}
			className={[
				"ui-button",
				`ui-button--${variant}`,
				`ui-button--${size}`,
				className,
			]
				.filter(Boolean)
				.join(" ")}
			type={type}
			{...props}
		>
			{icon ? <span className="ui-button__icon">{icon}</span> : null}
			<span>{children}</span>
		</button>
	);
});
