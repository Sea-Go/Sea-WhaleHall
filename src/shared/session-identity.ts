/** Exact Bun-owned login generation used to bind durable account work. */
export interface AuthSessionIdentity {
	accountId: string;
	sessionId: string;
	generation: number;
}
