import { Component, type ErrorInfo, type ReactNode } from "react";
import { CircleAlert, RefreshCw } from "lucide-react";
import { Button } from "../shared/ui/Button";

interface ClientErrorBoundaryProps {
	children: ReactNode;
}

interface ClientErrorBoundaryState {
	error: Error | null;
}

/** Keeps a renderer exception from turning the whole desktop window blank. */
export class ClientErrorBoundary extends Component<
	ClientErrorBoundaryProps,
	ClientErrorBoundaryState
> {
	state: ClientErrorBoundaryState = { error: null };

	static getDerivedStateFromError(error: Error): ClientErrorBoundaryState {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		console.error("[client] Render failed", {
			category: "render",
			message: error.message,
			componentStack: info.componentStack,
		});
	}

	render(): ReactNode {
		if (!this.state.error) return this.props.children;
		const diagnostic = rendererDiagnostic(this.state.error);
		return (
			<main className="client-render-error" role="alert">
				<div className="client-render-error__icon" aria-hidden="true">
					<CircleAlert size={24} />
				</div>
				<p>页面显示异常</p>
				<h1>暂时无法显示当前页面</h1>
				<span>请重新加载；你的本地日历和已确认计划不会受影响。</span>
				<code className="client-render-error__diagnostic">{diagnostic}</code>
				<Button variant="primary" icon={<RefreshCw size={16} />} onClick={() => window.location.reload()}>
					重新加载
				</Button>
			</main>
		);
	}
}

function rendererDiagnostic(error: Error): string {
	const message = error.message.replace(/[\r\n\t]+/g, " ").trim();
	return `${error.name || "Error"}: ${message.slice(0, 220) || "unknown renderer error"}`;
}
