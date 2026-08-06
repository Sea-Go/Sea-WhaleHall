import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	FileRelayRecordStore,
	FileSessionStore,
	JsonFileUserStore,
} from "./file-stores.js";
import {
	createNodeModelRelayServer,
	listenNodeModelRelayServer,
} from "./node-server.js";
import {
	CPU_ONLY_OLLAMA_CHAT_COMPLETIONS_URL,
	createModelRelayHandler,
} from "./server.js";

export async function startModelRelayFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
): Promise<ReturnType<typeof createNodeModelRelayServer>> {
	const usersPath = requiredEnvironment(
		environment,
		"WHALEHALL_RELAY_USERS_FILE",
	);
	const dataDirectory = resolve(
		requiredEnvironment(environment, "WHALEHALL_RELAY_DATA_DIR"),
	);
	const host = "127.0.0.1";
	const port = 8787;

	const users = await JsonFileUserStore.open(usersPath);
	const sessions = new FileSessionStore(join(dataDirectory, "sessions.json"));
	const records = new FileRelayRecordStore(join(dataDirectory, "records"));
	const handler = createModelRelayHandler(
		{
			providerChatCompletionsUrl: CPU_ONLY_OLLAMA_CHAT_COMPLETIONS_URL,
			allowedModels: ["qwen3:1.7b"],
			recordRetentionMs: 30 * 24 * 60 * 60_000,
			chatRequestsPerMinute: optionalInteger(
				environment.WHALEHALL_CHAT_REQUESTS_PER_MINUTE,
				60,
				1,
				10_000,
			),
			reflectionRequestsPerMinute: optionalInteger(
				environment.WHALEHALL_REFLECTION_REQUESTS_PER_MINUTE,
				20,
				1,
				10_000,
			),
			reflectionAuthenticationAttemptsPerMinute: optionalInteger(
				environment.WHALEHALL_REFLECTION_AUTH_ATTEMPTS_PER_MINUTE,
				20,
				1,
				10_000,
			),
			reflectionUpstreamTimeoutMs: optionalInteger(
				environment.WHALEHALL_REFLECTION_UPSTREAM_TIMEOUT_MS,
				195_000,
				1,
				10 * 60_000,
			),
			loginAttemptsPerMinute: optionalInteger(
				environment.WHALEHALL_LOGIN_ATTEMPTS_PER_MINUTE,
				10,
				1,
				1_000,
			),
			allowInsecureLoopbackProvider: true,
		},
		{ users, sessions, records },
	);
	const server = createNodeModelRelayServer(handler);
	await listenNodeModelRelayServer(server, { host, port });
	return server;
}

function requiredEnvironment(
	environment: NodeJS.ProcessEnv,
	name: string,
): string {
	const value = environment[name]?.trim();
	if (!value) throw new Error(`${name} is required.`);
	return value;
}

function optionalInteger(
	value: string | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	if (value === undefined || value.trim() === "") return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new Error("Numeric relay configuration is outside its safe range.");
	}
	return parsed;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	startModelRelayFromEnvironment()
		.then((server) => {
			const address = server.address();
			const display =
				typeof address === "object" && address
					? `${address.address}:${address.port}`
					: "configured socket";
			process.stdout.write(`WhaleHall model relay listening on ${display}\n`);
			const stop = () => server.close(() => process.exit(0));
			process.once("SIGINT", stop);
			process.once("SIGTERM", stop);
		})
		.catch((error: unknown) => {
			const message =
				error instanceof Error
					? error.message
					: "Unknown configuration failure.";
			process.stderr.write(
				`WhaleHall model relay failed to start: ${message}\n`,
			);
			process.exitCode = 1;
		});
}
