import type { ReactNode } from "react";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { AuthController } from "./AuthController";
import { AuthBootScreen, AuthPage } from "./AuthPage";
import type { AuthService } from "./auth-service";
import type { AuthCredentials, AuthSession } from "./domain";

export interface AuthenticatedAppContext {
	session: AuthSession;
	logout: () => void;
}

export interface AuthGateProps {
	service: AuthService;
	renderAuthenticated: (context: AuthenticatedAppContext) => ReactNode;
}

export function AuthGate({ service, renderAuthenticated }: AuthGateProps) {
	const controller = useMemo(() => new AuthController(service), [service]);
	const state = useSyncExternalStore(
		controller.subscribe,
		controller.getSnapshot,
		controller.getSnapshot,
	);

	useEffect(() => {
		void controller.start();
		return () => controller.stop();
	}, [controller]);

	function handleSubmit(credentials: AuthCredentials): Promise<void> {
		return controller.signIn(credentials);
	}

	if (state.status === "booting") {
		return <AuthBootScreen operation={state.operation} />;
	}

	if (state.status === "authenticated") {
		return renderAuthenticated({
			session: state.session,
			logout: () => {
				void controller.signOut();
			},
		});
	}

	return (
		<AuthPage
			state={state}
			onSubmit={handleSubmit}
			onRetry={() => controller.retry()}
		/>
	);
}
