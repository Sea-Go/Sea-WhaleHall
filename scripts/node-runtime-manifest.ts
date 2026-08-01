import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	chmod,
	copyFile,
	mkdir,
	mkdtemp,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const NODE_RUNTIME_VERSION = "22.18.0" as const;
export const NODE_RUNTIME_VERSION_LINE = `v${NODE_RUNTIME_VERSION}` as const;

export type NodeRuntimePlatform = "darwin" | "linux" | "win";
export type NodeRuntimeArch = "arm64" | "x64";
export type NodeRuntimeTarget =
	| "darwin-arm64"
	| "darwin-x64"
	| "linux-arm64"
	| "linux-x64"
	| "win-arm64"
	| "win-x64";

export interface NodeRuntimeRelease {
	readonly version: typeof NODE_RUNTIME_VERSION;
	readonly target: NodeRuntimeTarget;
	readonly platform: NodeRuntimePlatform;
	readonly arch: NodeRuntimeArch;
	readonly filename: string;
	readonly url: string;
	readonly sha256: string;
	readonly executableArchivePath: string;
	readonly executableName: "node" | "node.exe";
}

const releaseBaseUrl = `https://nodejs.org/dist/v${NODE_RUNTIME_VERSION}`;

function release(
	platform: NodeRuntimePlatform,
	arch: NodeRuntimeArch,
	extension: ".tar.gz" | ".tar.xz" | ".zip",
	sha256: string,
): NodeRuntimeRelease {
	const target = `${platform}-${arch}` as NodeRuntimeTarget;
	const archiveRoot = `node-v${NODE_RUNTIME_VERSION}-${platform}-${arch}`;
	const filename = `${archiveRoot}${extension}`;
	const executableName = platform === "win" ? "node.exe" : "node";
	return Object.freeze({
		version: NODE_RUNTIME_VERSION,
		target,
		platform,
		arch,
		filename,
		url: `${releaseBaseUrl}/${filename}`,
		sha256,
		executableArchivePath:
			platform === "win"
				? `${archiveRoot}/node.exe`
				: `${archiveRoot}/bin/node`,
		executableName,
	});
}

/**
 * Pinned official Node.js releases used by the Mastra sidecar. The digests are
 * the values published in Node.js v22.18.0 SHASUMS256.txt.
 */
export const NODE_RUNTIME_MANIFEST: Readonly<
	Record<NodeRuntimeTarget, NodeRuntimeRelease>
> = Object.freeze({
	"darwin-arm64": release(
		"darwin",
		"arm64",
		".tar.gz",
		"2c12913cba67af77ded8a399df3fd91c2e7f8628c7079da40bb9ff33bf00dfc0",
	),
	"darwin-x64": release(
		"darwin",
		"x64",
		".tar.gz",
		"9c8aa1e5ff5780b38cc1134e2263d84e2f4308eb84c02515e3af33936ca02cdc",
	),
	"linux-arm64": release(
		"linux",
		"arm64",
		".tar.xz",
		"04fca1b9afecf375f26b41d65d52aa1703a621abea5a8948c7d1e351e85edade",
	),
	"linux-x64": release(
		"linux",
		"x64",
		".tar.xz",
		"c1bfeecf1d7404fa74728f9db72e697decbd8119ccc6f5a294d795756dfcfca7",
	),
	"win-arm64": release(
		"win",
		"arm64",
		".zip",
		"023afb3d25c4c7d10cb6eb8a64865c347b56d4b07e6690606d021130a9192263",
	),
	"win-x64": release(
		"win",
		"x64",
		".zip",
		"c95d8a7e1c99e669cc08c9f1176e068c1f50847c37908fcb8c35b62482366511",
	),
});

const defaultProjectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export interface CommandResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export type CommandRunner = (
	command: readonly string[],
	options: { readonly cwd: string },
) => Promise<CommandResult>;

export const runCommand: CommandRunner = async (command, options) => {
	const result = Bun.spawnSync([...command], {
		cwd: options.cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
};

export function repositoryTargetName(target: NodeRuntimeTarget): string {
	return target.startsWith("darwin-")
		? target.replace(/^darwin-/, "macos-")
		: target;
}

export function nodeRuntimeTarget(
	platform: NodeRuntimePlatform | "macos",
	arch: NodeRuntimeArch,
): NodeRuntimeTarget {
	const officialPlatform = platform === "macos" ? "darwin" : platform;
	return `${officialPlatform}-${arch}` as NodeRuntimeTarget;
}

export function getNodeRuntimeRelease(
	target: NodeRuntimeTarget,
): NodeRuntimeRelease {
	const selected = NODE_RUNTIME_MANIFEST[target];
	if (!selected) {
		throw new Error(`Unsupported Node runtime target: ${String(target)}`);
	}
	return selected;
}

export async function sha256File(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

export async function verifyNodeArchive(
	archivePath: string,
	release: NodeRuntimeRelease,
): Promise<void> {
	const actual = await sha256File(archivePath);
	if (actual !== release.sha256) {
		throw new Error(
			`Node runtime archive checksum mismatch for ${release.filename}: expected ${release.sha256}, received ${actual}.`,
		);
	}
}

async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export interface DownloadNodeArchiveOptions {
	readonly fetchImpl?: typeof fetch;
}

/** Downloads a pinned archive and promotes it only after its SHA-256 matches. */
export async function downloadNodeArchive(
	release: NodeRuntimeRelease,
	archivePath: string,
	options: DownloadNodeArchiveOptions = {},
): Promise<string> {
	if (await isFile(archivePath)) {
		await verifyNodeArchive(archivePath, release);
		return archivePath;
	}

	const officialUrl = new URL(release.url);
	if (
		officialUrl.protocol !== "https:" ||
		officialUrl.hostname !== "nodejs.org" ||
		!officialUrl.pathname.startsWith(`/dist/v${NODE_RUNTIME_VERSION}/`)
	) {
		throw new Error(`Refusing non-official Node runtime URL: ${release.url}`);
	}

	await mkdir(dirname(archivePath), { recursive: true });
	const temporaryPath = `${archivePath}.download-${process.pid}-${randomUUID()}`;
	try {
		const response = await (options.fetchImpl ?? fetch)(release.url, {
			redirect: "follow",
		});
		if (!response.ok) {
			throw new Error(
				`Failed to download ${release.url}: HTTP ${response.status} ${response.statusText}`,
			);
		}
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength === 0) {
			throw new Error(`Downloaded Node runtime archive is empty: ${release.url}`);
		}
		await writeFile(temporaryPath, bytes, { flag: "wx" });
		await verifyNodeArchive(temporaryPath, release);
		try {
			await rename(temporaryPath, archivePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			await verifyNodeArchive(archivePath, release);
		}
		return archivePath;
	} finally {
		await rm(temporaryPath, { force: true });
	}
}

function safeArchiveEntryPath(root: string, archiveEntry: string): string {
	const path = resolve(root, ...archiveEntry.split("/"));
	if (path !== root && !path.startsWith(`${root}${sep}`)) {
		throw new Error(`Archive entry escapes extraction root: ${archiveEntry}`);
	}
	return path;
}

export interface ExtractNodeArchiveOptions {
	readonly run?: CommandRunner;
}

/** Extracts only the Node executable from an already verified official archive. */
export async function extractNodeArchive(
	release: NodeRuntimeRelease,
	archivePath: string,
	extractionRoot: string,
	options: ExtractNodeArchiveOptions = {},
): Promise<string> {
	await mkdir(extractionRoot, { recursive: true });
	// Git Bash places GNU tar ahead of Windows' archive-aware bsdtar. GNU tar
	// interprets `D:` archive paths as remote hosts, so select the OS binary
	// explicitly on Windows while retaining the normal tar tool on Unix hosts.
	const archiveTool =
		process.platform === "win32"
			? resolve(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
			: "tar";
	const result = await (options.run ?? runCommand)(
		[
			archiveTool,
			"-xf",
			archivePath,
			"-C",
			extractionRoot,
			release.executableArchivePath,
		],
		{ cwd: extractionRoot },
	);
	if (result.exitCode !== 0) {
		throw new Error(
			`Failed to extract ${release.executableArchivePath} from ${release.filename}: ${result.stderr.trim() || `tar exited ${result.exitCode}`}`,
		);
	}
	const executable = safeArchiveEntryPath(
		extractionRoot,
		release.executableArchivePath,
	);
	if (!(await isFile(executable))) {
		throw new Error(
			`Verified archive did not contain ${release.executableArchivePath}.`,
		);
	}
	return executable;
}

export interface VerifyNodeRuntimeOptions {
	readonly run?: CommandRunner;
}

/** Executes the staged binary itself; PATH is never consulted. */
export async function verifyStagedNodeRuntime(
	executablePath: string,
	options: VerifyNodeRuntimeOptions = {},
): Promise<void> {
	const result = await (options.run ?? runCommand)(
		[executablePath, "--version"],
		{ cwd: dirname(executablePath) },
	);
	if (result.exitCode !== 0) {
		throw new Error(
			`Staged Node runtime failed to execute (${result.exitCode}): ${result.stderr.trim()}`,
		);
	}
	const actual = result.stdout.trim();
	if (actual !== NODE_RUNTIME_VERSION_LINE) {
		throw new Error(
			`Staged Node runtime must be exactly ${NODE_RUNTIME_VERSION_LINE}; received ${actual || "no version output"}.`,
		);
	}
}

export interface StageNodeRuntimeOptions {
	readonly target: NodeRuntimeTarget;
	readonly projectRoot?: string;
	readonly stageDirectory?: string;
	readonly cacheDirectory?: string;
	readonly fetchImpl?: typeof fetch;
	readonly run?: CommandRunner;
}

export interface StagedNodeRuntime {
	readonly target: NodeRuntimeTarget;
	readonly version: typeof NODE_RUNTIME_VERSION;
	readonly executablePath: string;
	readonly archivePath: string;
}

/**
 * Downloads/verifies the pinned archive, extracts into a temporary directory,
 * and stages only node[.exe] under .native/<target>.
 */
export async function stageNodeRuntime(
	options: StageNodeRuntimeOptions,
): Promise<StagedNodeRuntime> {
	const release = getNodeRuntimeRelease(options.target);
	const projectRoot = options.projectRoot ?? defaultProjectRoot;
	const stageDirectory =
		options.stageDirectory ??
		resolve(projectRoot, ".native", repositoryTargetName(options.target));
	const cacheDirectory =
		options.cacheDirectory ??
		resolve(
			projectRoot,
			".native",
			".cache",
			"node-runtime",
			`v${NODE_RUNTIME_VERSION}`,
		);
	const archivePath = resolve(cacheDirectory, release.filename);
	await downloadNodeArchive(release, archivePath, {
		fetchImpl: options.fetchImpl,
	});
	// A cache hit is trusted only after the same official digest check above.
	await verifyNodeArchive(archivePath, release);

	await mkdir(cacheDirectory, { recursive: true });
	await mkdir(stageDirectory, { recursive: true });
	const extractionRoot = await mkdtemp(resolve(cacheDirectory, "extract-"));
	const destination = resolve(stageDirectory, release.executableName);
	const stagingSuffix = `${process.pid}-${randomUUID()}`;
	const stagingPath = resolve(
		stageDirectory,
		release.platform === "win"
			? `.node.staging-${stagingSuffix}.exe`
			: `.node.staging-${stagingSuffix}`,
	);

	try {
		const extracted = await extractNodeArchive(
			release,
			archivePath,
			extractionRoot,
			{ run: options.run },
		);
		await copyFile(extracted, stagingPath);
		if (release.platform !== "win") await chmod(stagingPath, 0o755);
		await verifyStagedNodeRuntime(stagingPath, { run: options.run });
		await rm(destination, { force: true });
		await rename(stagingPath, destination);
		await verifyStagedNodeRuntime(destination, { run: options.run });
		return {
			target: release.target,
			version: release.version,
			executablePath: destination,
			archivePath,
		};
	} finally {
		await rm(stagingPath, { force: true });
		await rm(extractionRoot, { force: true, recursive: true });
	}
}
