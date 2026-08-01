import { loadOrCreateInstallationId } from "../../src/bun/installation-id";

const agentDataDirectory = process.argv[2];
if (!agentDataDirectory) throw new Error("Missing Agent data directory.");

process.stdout.write(await loadOrCreateInstallationId(agentDataDirectory));
