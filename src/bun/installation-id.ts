import { link, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const installationIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/** Stable opaque installation identifier. It is not a credential. */
export async function loadOrCreateInstallationId(agentDataDirectory: string): Promise<string> {
	const path = join(agentDataDirectory, "installation-id");
	const existing = await readInstallationId(path);
	if (existing) return existing;

	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const value = randomUUID().toLowerCase();
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const handle = await open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(`${value}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		// Linking a fully-written temporary file is an atomic create-if-absent on
		// both NTFS and APFS. A rename may replace another process' winner on
		// POSIX, while opening the final path directly exposes partial contents.
		await link(temporary, path);
		return value;
	} catch (error) {
		if (!isAlreadyExists(error)) throw error;
		const winner = await readInstallationId(path);
		if (!winner) {
			throw new Error("WhaleHall installation ID disappeared during creation.");
		}
		return winner;
	} finally {
		await rm(temporary, { force: true });
	}
}

async function readInstallationId(path: string): Promise<string | null> {
	try {
		const existing = (await readFile(path, "utf8")).trim().toLowerCase();
		if (!installationIdPattern.test(existing)) {
			throw new Error("WhaleHall installation ID file is invalid.");
		}
		return existing;
	} catch (error) {
		if (isNotFound(error)) return null;
		throw error;
	}
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
