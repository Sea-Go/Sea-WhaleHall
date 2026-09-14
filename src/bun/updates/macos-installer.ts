import { dlopen, FFIType } from "bun:ffi";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
	access,
	chmod,
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";

const MAC_INSTALL_PLAN_SCHEMA = "whalehall.macos-install-plan.v1" as const;
const MAC_INSTALL_READY_SCHEMA = "whalehall.macos-install-ready.v1" as const;
const MAC_TRANSACTION_PREFIX = ".whalehall-update-";
const MAC_HELPER_SPAWN_TIMEOUT_MS = 10_000;
const MAC_HELPER_READY_TIMEOUT_MS = 10_000;
const MAC_HELPER_CLOSE_TIMEOUT_MS = 5_000;
const MAC_PROCESS_IDENTITY_TIMEOUT_MS = 5_000;
const MAC_CODESIGN_TIMEOUT_MS = 60_000;
const MAX_TAR_ENTRIES = 50_000;
const MAX_ARCHIVE_PATH_BYTES = 4_096;
const TAR_BLOCK_SIZE = 512;

export type MacUpdateInstallerPlan = {
	readonly schemaVersion: typeof MAC_INSTALL_PLAN_SCHEMA;
	readonly transactionId: string;
	readonly readyNonce: string;
	readonly mainProcessId: number;
	readonly mainProcessStartIdentity: string;
	readonly launcherProcessId: number;
	readonly launcherProcessStartIdentity: string;
	readonly currentAppPath: string;
	readonly bundleName: string;
};

export type MacUpdateInstallerPaths = {
	readonly appParentPath: string;
	readonly transactionRoot: string;
	readonly extractionRoot: string;
	readonly candidateAppPath: string;
	readonly backupAppPath: string;
	readonly failedAppPath: string;
	readonly helperPath: string;
	readonly planPath: string;
	readonly readyPath: string;
	readonly resultPath: string;
};

export type PreparedMacUpdate = {
	readonly plan: MacUpdateInstallerPlan;
	readonly paths: MacUpdateInstallerPaths;
	readonly helperRuntimePath: string;
};

export type MacUpdateInstallerHandle = {
	readonly processId: number;
	readonly closed: Promise<void>;
	isClosed(): boolean;
	detach(): void;
	terminateAndWait(): Promise<void>;
};

export type PrepareMacUpdateTransactionInput = {
	readonly stagedTarPath: string;
	/** The running Bun executable inside Current.app/Contents/MacOS. */
	readonly executablePath: string;
	readonly mainProcessId: number;
	readonly launcherProcessId: number;
	/** Test seam only; production launches the already-running bundled Bun. */
	readonly helperRuntimePath?: string;
	readonly verifyCandidate?: (candidateAppPath: string) => Promise<void>;
};

export type PrepareMacUpdateInstallInput = PrepareMacUpdateTransactionInput & {
	readonly exitForUpdate: () => void;
	readonly readyTimeoutMs?: number;
	readonly launchInstaller?: (
		prepared: PreparedMacUpdate,
	) => Promise<MacUpdateInstallerHandle>;
};

type ParsedTarArchive = {
	readonly bundleName: string;
	readonly files: ReadonlySet<string>;
	readonly directories: ReadonlySet<string>;
};

/**
 * Resolves every path from one small, strict plan. The transaction sits beside
 * the running app so Darwin's atomic directory exchange can never cross a
 * volume, including when /Applications and Application Support are separate.
 */
export function macUpdateInstallerPaths(
	plan: MacUpdateInstallerPlan,
): MacUpdateInstallerPaths {
	validateMacUpdateInstallerPlanShape(plan);
	const appParentPath = dirname(plan.currentAppPath);
	const transactionRoot = join(
		appParentPath,
		`${MAC_TRANSACTION_PREFIX}${plan.transactionId}`,
	);
	const extractionRoot = join(transactionRoot, "candidate-root");
	return {
		appParentPath,
		transactionRoot,
		extractionRoot,
		candidateAppPath: join(extractionRoot, plan.bundleName),
		backupAppPath: join(transactionRoot, "backup.app"),
		failedAppPath: join(transactionRoot, "failed-candidate.app"),
		helperPath: join(transactionRoot, "install-helper.mjs"),
		planPath: join(transactionRoot, "plan.json"),
		readyPath: join(transactionRoot, "armed.json"),
		resultPath: join(transactionRoot, "result.json"),
	};
}

/**
 * Performs one Darwin VFS exchange. Both names exist before and after the
 * syscall; a crash cannot expose a missing application path between renames.
 */
export async function atomicSwapMacDirectories(
	firstPath: string,
	secondPath: string,
): Promise<void> {
	if (process.platform !== "darwin") {
		throw new Error("The atomic macOS application swap is unavailable.");
	}
	for (const path of [firstPath, secondPath]) {
		if (!isAbsolute(path) || path.includes("\0")) {
			throw new Error("The atomic macOS application swap path is invalid.");
		}
		const value = await lstat(path);
		if (!value.isDirectory() || value.isSymbolicLink()) {
			throw new Error(
				"The atomic macOS application swap requires directories.",
			);
		}
	}
	const [firstParent, secondParent] = await Promise.all([
		stat(dirname(firstPath)),
		stat(dirname(secondPath)),
	]);
	if (firstParent.dev !== secondParent.dev) {
		throw new Error(
			"The macOS update candidate is not on the application volume.",
		);
	}

	const library = dlopen("/usr/lib/libSystem.B.dylib", {
		renameatx_np: {
			args: [
				FFIType.i32,
				FFIType.cstring,
				FFIType.i32,
				FFIType.cstring,
				FFIType.u32,
			],
			returns: FFIType.i32,
		},
	});
	try {
		const first = new TextEncoder().encode(`${firstPath}\0`);
		const second = new TextEncoder().encode(`${secondPath}\0`);
		const result = library.symbols.renameatx_np(
			-2,
			first,
			-2,
			second,
			0x0000_0002,
		);
		if (result !== 0) {
			throw new Error("Darwin rejected the atomic application directory swap.");
		}
	} finally {
		library.close();
	}
}

export async function prepareMacUpdateTransaction(
	input: PrepareMacUpdateTransactionInput,
): Promise<PreparedMacUpdate> {
	if (process.platform !== "darwin") {
		throw new Error(
			"The macOS update installer is unavailable on this platform.",
		);
	}
	validateProcessId(input.mainProcessId);
	validateProcessId(input.launcherProcessId);
	if (input.mainProcessId === input.launcherProcessId) {
		throw new Error("The macOS updater process identities are invalid.");
	}

	const executablePath = await canonicalRunningExecutable(input.executablePath);
	const currentAppPath = resolve(dirname(executablePath), "..", "..");
	const canonicalCurrentAppPath = await realpath(currentAppPath);
	if (canonicalCurrentAppPath !== currentAppPath) {
		throw new Error("The running macOS application path is not canonical.");
	}
	const currentApp = await lstat(currentAppPath);
	if (!currentApp.isDirectory() || currentApp.isSymbolicLink()) {
		throw new Error("The running macOS application bundle is invalid.");
	}
	const bundleName = basename(currentAppPath);
	validateMacBundleName(bundleName);
	const currentLauncherPath = join(
		currentAppPath,
		"Contents",
		"MacOS",
		"launcher",
	);
	await access(currentLauncherPath, fsConstants.X_OK);

	const [mainProcessStartIdentity, launcherProcessStartIdentity] =
		await Promise.all([
			readMacProcessStartIdentity(input.mainProcessId),
			readMacProcessStartIdentity(input.launcherProcessId),
		]);
	if (
		mainProcessStartIdentity === null ||
		launcherProcessStartIdentity === null
	) {
		throw new Error(
			"The macOS updater could not lock the running process identities.",
		);
	}

	const plan: MacUpdateInstallerPlan = {
		schemaVersion: MAC_INSTALL_PLAN_SCHEMA,
		transactionId: randomBytes(16).toString("hex"),
		readyNonce: randomBytes(16).toString("hex"),
		mainProcessId: input.mainProcessId,
		mainProcessStartIdentity,
		launcherProcessId: input.launcherProcessId,
		launcherProcessStartIdentity,
		currentAppPath,
		bundleName,
	};
	const paths = macUpdateInstallerPaths(plan);
	const helperRuntimePath = await canonicalHelperRuntime(
		input.helperRuntimePath ?? executablePath,
	);

	await assertTrustedMacAppParent(paths.appParentPath, currentAppPath);
	await mkdir(paths.transactionRoot, { recursive: false, mode: 0o700 });
	let prepared = false;
	try {
		await assertNewMacTransactionRoot(paths);
		await mkdir(paths.extractionRoot, { recursive: false, mode: 0o700 });
		const archiveBytes = await readVerifiedTar(input.stagedTarPath);
		const parsed = parseAndValidateTarArchive(archiveBytes, bundleName);
		const archive = new Bun.Archive(archiveBytes);
		const files = await archive.files();
		validateBunArchiveFiles(files, parsed);
		await archive.extract(paths.extractionRoot);
		await validateExtractedMacBundle(paths.candidateAppPath, parsed);
		await (input.verifyCandidate ?? verifyMacCandidateCodesign)(
			paths.candidateAppPath,
		);
		await writeFile(paths.helperPath, macUpdateInstallerHelperSource(), {
			encoding: "utf8",
			mode: 0o700,
			flag: "wx",
		});
		await chmod(paths.helperPath, 0o700);
		await writeFile(paths.planPath, JSON.stringify(plan), {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
		prepared = true;
		return { plan, paths, helperRuntimePath };
	} finally {
		if (!prepared) {
			await rm(paths.transactionRoot, { recursive: true, force: true }).catch(
				() => undefined,
			);
		}
	}
}

export async function launchMacUpdateInstaller(
	prepared: PreparedMacUpdate,
): Promise<MacUpdateInstallerHandle> {
	assertPreparedMacUpdate(prepared);
	await access(prepared.helperRuntimePath, fsConstants.X_OK);
	return new Promise<MacUpdateInstallerHandle>(
		(resolveHandle, rejectHandle) => {
			const child = spawn(
				prepared.helperRuntimePath,
				[prepared.paths.helperPath, prepared.paths.planPath],
				{
					cwd: prepared.paths.transactionRoot,
					detached: true,
					stdio: "ignore",
					shell: false,
					env: { ...process.env, LC_ALL: "C", LANG: "C" },
				},
			);
			let spawned = false;
			let closed = false;
			let settled = false;
			let resolveClosed!: () => void;
			const closedPromise = new Promise<void>((resolve) => {
				resolveClosed = resolve;
			});
			child.once("close", () => {
				closed = true;
				resolveClosed();
			});
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(spawnTimer);
				if (error !== undefined) {
					rejectHandle(error);
					return;
				}
				const processId = child.pid;
				if (processId === undefined) {
					rejectHandle(
						new Error("The macOS update helper has no process identity."),
					);
					return;
				}
				resolveHandle({
					processId,
					closed: closedPromise,
					isClosed() {
						return closed;
					},
					detach() {
						child.unref();
					},
					async terminateAndWait() {
						if (!closed) {
							try {
								child.kill("SIGKILL");
							} catch {
								// The close event, not kill acknowledgement, releases ownership.
							}
						}
						await promiseWithTimeout(
							closedPromise,
							MAC_HELPER_CLOSE_TIMEOUT_MS,
							"The macOS update helper did not close.",
						);
					},
				});
			};
			child.once("spawn", () => {
				spawned = true;
				finish();
			});
			child.once("error", (error) => {
				if (!spawned) finish(error);
			});
			const spawnTimer = setTimeout(() => {
				if (!closed) {
					try {
						child.kill("SIGKILL");
					} catch {
						// Exact close remains the ownership boundary.
					}
				}
				void closedPromise.then(() =>
					finish(new Error("The macOS update helper did not start.")),
				);
			}, MAC_HELPER_SPAWN_TIMEOUT_MS);
		},
	);
}

export async function waitForMacUpdateInstallerReady(
	prepared: PreparedMacUpdate,
	handle: MacUpdateInstallerHandle,
	timeoutMs: number = MAC_HELPER_READY_TIMEOUT_MS,
): Promise<void> {
	assertPreparedMacUpdate(prepared);
	validatePositiveTimeout(timeoutMs);
	const deadline = Date.now() + timeoutMs;
	let helperClosed = false;
	void handle.closed.then(() => {
		helperClosed = true;
	});
	while (Date.now() < deadline) {
		if (helperClosed) {
			throw new Error("The macOS update helper closed before becoming ready.");
		}
		try {
			const readyStats = await lstat(prepared.paths.readyPath);
			if (
				!readyStats.isFile() ||
				readyStats.isSymbolicLink() ||
				readyStats.size <= 0 ||
				readyStats.size > 1_024
			) {
				throw new Error("The macOS update helper readiness proof is invalid.");
			}
			const raw = JSON.parse(
				await readFile(prepared.paths.readyPath, "utf8"),
			) as unknown;
			validateReadyProof(raw, prepared.plan, handle.processId);
			// The ready file is durable evidence, not live ownership. Recheck the
			// exact child synchronously after parsing it; the caller performs the
			// exit handoff in the same JavaScript turn with no intervening await.
			if (handle.isClosed()) {
				throw new Error("The macOS update helper closed after becoming ready.");
			}
			return;
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
		}
		await delay(25);
	}
	throw new Error("The macOS update helper did not become ready.");
}

export async function cleanupPreparedMacUpdate(
	prepared: PreparedMacUpdate,
): Promise<void> {
	assertPreparedMacUpdate(prepared);
	await rm(prepared.paths.transactionRoot, { recursive: true, force: true });
}

/**
 * Complete parent-side handoff. The caller must have drained application
 * owners before invoking this function. A recoverable error is never exposed
 * while an installer capable of swapping the bundle is still alive.
 */
export async function prepareMacUpdateInstall(
	input: PrepareMacUpdateInstallInput,
): Promise<void> {
	let prepared: PreparedMacUpdate | null = null;
	let helper: MacUpdateInstallerHandle | null = null;
	const terminateOwnedHelper = async () => {
		if (helper === null) return;
		try {
			await helper.terminateAndWait();
		} catch {
			await helper.closed;
		}
	};
	try {
		prepared = await prepareMacUpdateTransaction(input);
		helper = await (input.launchInstaller ?? launchMacUpdateInstaller)(
			prepared,
		);
		await waitForMacUpdateInstallerReady(
			prepared,
			helper,
			input.readyTimeoutMs ?? MAC_HELPER_READY_TIMEOUT_MS,
		);
	} catch (error) {
		await terminateOwnedHelper();
		if (prepared !== null) await cleanupPreparedMacUpdate(prepared);
		throw error;
	}

	if (helper.isClosed()) {
		await terminateOwnedHelper();
		await cleanupPreparedMacUpdate(prepared);
		throw new Error("The macOS update helper closed before the exit handoff.");
	}
	helper.detach();
	try {
		input.exitForUpdate();
	} catch (error) {
		await terminateOwnedHelper();
		await cleanupPreparedMacUpdate(prepared);
		throw error;
	}

	// A real exit never returns. If it does, the exact helper is still waiting
	// for this PID and can therefore be safely disarmed before cleanup.
	await terminateOwnedHelper();
	await cleanupPreparedMacUpdate(prepared);
	throw new Error(
		"The macOS updater exit handoff returned without terminating the application.",
	);
}

function validateMacUpdateInstallerPlanShape(
	plan: MacUpdateInstallerPlan,
): void {
	if (
		plan.schemaVersion !== MAC_INSTALL_PLAN_SCHEMA ||
		!/^[a-f0-9]{32}$/u.test(plan.transactionId) ||
		!/^[a-f0-9]{32}$/u.test(plan.readyNonce)
	) {
		throw new Error("The macOS update installer plan is invalid.");
	}
	validateProcessId(plan.mainProcessId);
	validateProcessId(plan.launcherProcessId);
	validateProcessStartIdentity(plan.mainProcessStartIdentity);
	validateProcessStartIdentity(plan.launcherProcessStartIdentity);
	validateMacBundleName(plan.bundleName);
	if (
		!isAbsolute(plan.currentAppPath) ||
		resolve(plan.currentAppPath) !== plan.currentAppPath ||
		basename(plan.currentAppPath) !== plan.bundleName
	) {
		throw new Error("The macOS update installer app path is invalid.");
	}
}

function validateReadyProof(
	value: unknown,
	plan: MacUpdateInstallerPlan,
	helperProcessId: number,
): void {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("The macOS update helper readiness proof is invalid.");
	}
	const proof = value as Record<string, unknown>;
	const keys = Object.keys(proof).sort();
	if (
		keys.join("\0") !==
			"helperProcessId\0nonce\0schemaVersion\0state\0transactionId" ||
		proof.schemaVersion !== MAC_INSTALL_READY_SCHEMA ||
		proof.transactionId !== plan.transactionId ||
		proof.nonce !== plan.readyNonce ||
		proof.state !== "armed" ||
		proof.helperProcessId !== helperProcessId
	) {
		throw new Error("The macOS update helper readiness proof is invalid.");
	}
}

async function canonicalRunningExecutable(path: string): Promise<string> {
	if (!isAbsolute(path) || path.includes("\0")) {
		throw new Error("The running macOS executable path is invalid.");
	}
	const canonical = await realpath(path);
	const value = await lstat(canonical);
	if (!value.isFile() || value.isSymbolicLink()) {
		throw new Error("The running macOS executable is invalid.");
	}
	await access(canonical, fsConstants.X_OK);
	return canonical;
}

async function canonicalHelperRuntime(path: string): Promise<string> {
	if (!isAbsolute(path) || path.includes("\0")) {
		throw new Error("The macOS update helper runtime path is invalid.");
	}
	const canonical = await realpath(path);
	const value = await lstat(canonical);
	if (!value.isFile() || value.isSymbolicLink()) {
		throw new Error("The macOS update helper runtime is invalid.");
	}
	await access(canonical, fsConstants.X_OK);
	return canonical;
}

async function assertTrustedMacAppParent(
	parentPath: string,
	currentAppPath: string,
): Promise<void> {
	const parent = await lstat(parentPath);
	if (
		!parent.isDirectory() ||
		parent.isSymbolicLink() ||
		(await realpath(parentPath)) !== parentPath ||
		dirname(currentAppPath) !== parentPath
	) {
		throw new Error("The macOS application parent directory is untrusted.");
	}
}

async function assertNewMacTransactionRoot(
	paths: MacUpdateInstallerPaths,
): Promise<void> {
	const root = await lstat(paths.transactionRoot);
	if (
		!root.isDirectory() ||
		root.isSymbolicLink() ||
		(await realpath(paths.transactionRoot)) !== paths.transactionRoot
	) {
		throw new Error("The macOS update transaction root is untrusted.");
	}
	const [parent, transaction] = await Promise.all([
		stat(paths.appParentPath),
		stat(paths.transactionRoot),
	]);
	if (parent.dev !== transaction.dev) {
		throw new Error("The macOS update transaction is on another volume.");
	}
}

function assertPreparedMacUpdate(prepared: PreparedMacUpdate): void {
	validateMacUpdateInstallerPlanShape(prepared.plan);
	const expected = macUpdateInstallerPaths(prepared.plan);
	for (const key of Object.keys(expected) as Array<
		keyof MacUpdateInstallerPaths
	>) {
		if (prepared.paths[key] !== expected[key]) {
			throw new Error("The prepared macOS update paths are inconsistent.");
		}
	}
	if (
		basename(prepared.paths.transactionRoot) !==
			`${MAC_TRANSACTION_PREFIX}${prepared.plan.transactionId}` ||
		dirname(prepared.paths.transactionRoot) !==
			dirname(prepared.plan.currentAppPath) ||
		prepared.paths.transactionRoot === prepared.plan.currentAppPath ||
		!isAbsolute(prepared.helperRuntimePath)
	) {
		throw new Error("The prepared macOS update is invalid.");
	}
}

async function readVerifiedTar(path: string): Promise<Uint8Array> {
	if (!isAbsolute(path) || path.includes("\0")) {
		throw new Error("The staged macOS update archive path is invalid.");
	}
	const value = await lstat(path);
	if (
		!value.isFile() ||
		value.isSymbolicLink() ||
		value.size <= TAR_BLOCK_SIZE
	) {
		throw new Error("The staged macOS update archive is invalid.");
	}
	return readFile(path);
}

function parseAndValidateTarArchive(
	archiveBytes: Uint8Array,
	expectedBundleName: string,
): ParsedTarArchive {
	const files = new Set<string>();
	const directories = new Set<string>();
	let offset = 0;
	let headers = 0;
	let pendingPaxHeader = false;
	let reachedEnd = false;
	while (offset + TAR_BLOCK_SIZE <= archiveBytes.byteLength) {
		const header = archiveBytes.subarray(offset, offset + TAR_BLOCK_SIZE);
		if (header.every((byte) => byte === 0)) {
			reachedEnd = true;
			break;
		}
		headers += 1;
		if (headers > MAX_TAR_ENTRIES * 2) {
			throw new Error("The macOS update archive has too many entries.");
		}
		validateTarChecksum(header);
		const size = parseTarOctal(header.subarray(124, 136), "size");
		const paddedSize = Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
		const contentStart = offset + TAR_BLOCK_SIZE;
		const nextOffset = contentStart + paddedSize;
		if (
			!Number.isSafeInteger(nextOffset) ||
			nextOffset > archiveBytes.byteLength
		) {
			throw new Error("The macOS update archive is truncated.");
		}
		const rawType = header[156] ?? 0;
		const type = rawType === 0 ? "0" : String.fromCharCode(rawType);
		if (type === "x") {
			if (pendingPaxHeader) {
				throw new Error("The macOS update archive has ambiguous metadata.");
			}
			validatePaxHeader(
				archiveBytes.subarray(contentStart, contentStart + size),
			);
			pendingPaxHeader = true;
			offset = nextOffset;
			continue;
		}
		if (type !== "0" && type !== "5") {
			throw new Error(
				"The macOS update archive contains a link or special entry.",
			);
		}
		pendingPaxHeader = false;
		const path = tarHeaderPath(header);
		const safePath = validateMacArchivePath(path, expectedBundleName);
		if (files.has(safePath) || directories.has(safePath)) {
			throw new Error("The macOS update archive contains a duplicate path.");
		}
		if (type === "5") {
			if (size !== 0) {
				throw new Error("The macOS update archive directory is invalid.");
			}
			directories.add(safePath);
		} else {
			files.add(safePath);
		}
		if (files.size + directories.size > MAX_TAR_ENTRIES) {
			throw new Error("The macOS update archive has too many entries.");
		}
		offset = nextOffset;
	}
	if (!reachedEnd || pendingPaxHeader || files.size === 0) {
		throw new Error("The macOS update archive is incomplete.");
	}
	for (const byte of archiveBytes.subarray(offset)) {
		if (byte !== 0) {
			throw new Error("The macOS update archive has trailing content.");
		}
	}
	for (const required of [
		`${expectedBundleName}/Contents/Info.plist`,
		`${expectedBundleName}/Contents/MacOS/launcher`,
		`${expectedBundleName}/Contents/Resources/version.json`,
	]) {
		if (!files.has(required)) {
			throw new Error(`The macOS update archive is missing ${required}.`);
		}
	}
	return { bundleName: expectedBundleName, files, directories };
}

function validateTarChecksum(header: Uint8Array): void {
	const expected = parseTarOctal(header.subarray(148, 156), "checksum");
	let actual = 0;
	for (let index = 0; index < TAR_BLOCK_SIZE; index += 1) {
		actual += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
	}
	if (actual !== expected) {
		throw new Error("The macOS update archive header checksum is invalid.");
	}
}

function parseTarOctal(field: Uint8Array, label: string): number {
	if ((field[0] ?? 0) >= 0x80) {
		throw new Error(`The macOS update archive ${label} is unsupported.`);
	}
	const raw = decodeTarText(field).replace(/\0.*$/su, "").trim();
	if (raw === "") return 0;
	if (!/^[0-7]+$/u.test(raw)) {
		throw new Error(`The macOS update archive ${label} is invalid.`);
	}
	const value = Number.parseInt(raw, 8);
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`The macOS update archive ${label} is invalid.`);
	}
	return value;
}

function tarHeaderPath(header: Uint8Array): string {
	const name = decodeTarText(header.subarray(0, 100)).replace(/\0.*$/su, "");
	const prefix = decodeTarText(header.subarray(345, 500)).replace(
		/\0.*$/su,
		"",
	);
	return prefix === "" ? name : `${prefix}/${name}`;
}

function decodeTarText(bytes: Uint8Array): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new Error("The macOS update archive contains invalid UTF-8.");
	}
}

function validatePaxHeader(bytes: Uint8Array): void {
	let offset = 0;
	while (offset < bytes.byteLength) {
		let space = offset;
		while (space < bytes.byteLength && bytes[space] !== 0x20) space += 1;
		const lengthText = new TextDecoder().decode(bytes.subarray(offset, space));
		if (space >= bytes.byteLength || !/^\d+$/u.test(lengthText)) {
			throw new Error("The macOS update archive PAX metadata is invalid.");
		}
		const length = Number.parseInt(lengthText, 10);
		const end = offset + length;
		if (
			!Number.isSafeInteger(length) ||
			length <= space - offset + 3 ||
			end > bytes.byteLength ||
			bytes[end - 1] !== 0x0a
		) {
			throw new Error("The macOS update archive PAX metadata is invalid.");
		}
		let equals = space + 1;
		while (equals < end - 1 && bytes[equals] !== 0x3d) equals += 1;
		if (equals === space + 1 || equals >= end - 1) {
			throw new Error("The macOS update archive PAX metadata is invalid.");
		}
		const key = decodeTarText(bytes.subarray(space + 1, equals));
		if (
			key !== "mtime" &&
			key !== "atime" &&
			key !== "ctime" &&
			!key.startsWith("LIBARCHIVE.xattr.") &&
			!key.startsWith("SCHILY.xattr.")
		) {
			throw new Error("The macOS update archive PAX metadata is unsafe.");
		}
		offset = end;
	}
}

function validateMacArchivePath(
	path: string,
	expectedBundleName: string,
): string {
	const withoutTrailingSlash = path.replace(/\/+$/u, "");
	const byteLength = new TextEncoder().encode(withoutTrailingSlash).byteLength;
	const components = withoutTrailingSlash.split("/");
	if (
		withoutTrailingSlash === "" ||
		byteLength > MAX_ARCHIVE_PATH_BYTES ||
		path.includes("\0") ||
		path.includes("\\") ||
		path.startsWith("/") ||
		components[0] !== expectedBundleName ||
		components.some(
			(component) =>
				component === "" ||
				component === "." ||
				component === ".." ||
				hasControlCharacter(component),
		)
	) {
		throw new Error("The macOS update archive contains an unsafe path.");
	}
	return withoutTrailingSlash;
}

function validateBunArchiveFiles(
	files: Map<string, File>,
	parsed: ParsedTarArchive,
): void {
	if (files.size !== parsed.files.size) {
		throw new Error("Bun did not recognize the exact macOS archive file set.");
	}
	for (const path of files.keys()) {
		const safePath = validateMacArchivePath(path, parsed.bundleName);
		if (!parsed.files.has(safePath)) {
			throw new Error("Bun recognized an unexpected macOS archive path.");
		}
	}
}

async function validateExtractedMacBundle(
	candidateAppPath: string,
	parsed: ParsedTarArchive,
): Promise<void> {
	const candidate = await lstat(candidateAppPath);
	if (!candidate.isDirectory() || candidate.isSymbolicLink()) {
		throw new Error("The extracted macOS application bundle is invalid.");
	}
	const canonicalRoot = await realpath(candidateAppPath);
	if (canonicalRoot !== candidateAppPath) {
		throw new Error("The extracted macOS application bundle is not canonical.");
	}
	const actualFiles = new Set<string>();
	const actualDirectories = new Set<string>([parsed.bundleName]);
	const visit = async (directory: string): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			const value = await lstat(path);
			if (value.isSymbolicLink()) {
				throw new Error("The extracted macOS application contains a link.");
			}
			const canonical = await realpath(path);
			if (
				canonical !== canonicalRoot &&
				!canonical.startsWith(`${canonicalRoot}${sep}`)
			) {
				throw new Error("The extracted macOS application escapes its bundle.");
			}
			const archivePath = `${parsed.bundleName}/${relative(
				candidateAppPath,
				path,
			)
				.split(sep)
				.join("/")}`;
			if (value.isDirectory()) {
				actualDirectories.add(archivePath);
				await visit(path);
			} else if (value.isFile() && value.nlink === 1) {
				actualFiles.add(archivePath);
			} else {
				throw new Error(
					"The extracted macOS application contains a special entry.",
				);
			}
		}
	};
	await visit(candidateAppPath);
	if (
		!sameStringSet(actualFiles, parsed.files) ||
		!sameStringSet(actualDirectories, parsed.directories)
	) {
		throw new Error("The extracted macOS application tree is incomplete.");
	}
	const launcher = join(candidateAppPath, "Contents", "MacOS", "launcher");
	await access(launcher, fsConstants.X_OK);
	const [candidateVolume, currentVolume] = await Promise.all([
		stat(candidateAppPath),
		stat(dirname(dirname(dirname(candidateAppPath)))),
	]);
	if (candidateVolume.dev !== currentVolume.dev) {
		throw new Error("The extracted macOS application is on another volume.");
	}
}

function sameStringSet(
	left: ReadonlySet<string>,
	right: ReadonlySet<string>,
): boolean {
	if (left.size !== right.size) return false;
	for (const value of left) if (!right.has(value)) return false;
	return true;
}

async function verifyMacCandidateCodesign(
	candidateAppPath: string,
): Promise<void> {
	await runOwnedProcess(
		"/usr/bin/codesign",
		["--verify", "--deep", "--strict", "--verbose=2", candidateAppPath],
		MAC_CODESIGN_TIMEOUT_MS,
		"The macOS update candidate failed code-signature verification.",
	);
}

async function readMacProcessStartIdentity(
	processId: number,
): Promise<string | null> {
	validateProcessId(processId);
	const result = await captureOwnedProcess(
		"/bin/ps",
		["-p", String(processId), "-o", "lstart="],
		MAC_PROCESS_IDENTITY_TIMEOUT_MS,
		1_024,
	);
	if (result.exitCode !== 0) return null;
	const identity = result.stdout.trim().replace(/\s+/gu, " ");
	validateProcessStartIdentity(identity);
	return identity;
}

function validateProcessStartIdentity(value: string): void {
	if (
		!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/u.test(
			value,
		)
	) {
		throw new Error("The macOS updater process start identity is invalid.");
	}
}

function validateMacBundleName(value: string): void {
	if (
		!value.endsWith(".app") ||
		value.length <= 4 ||
		value.length > 255 ||
		value.trim() !== value ||
		value.includes("/") ||
		value.includes("\\") ||
		value.includes("\0") ||
		hasControlCharacter(value)
	) {
		throw new Error("The macOS application bundle name is invalid.");
	}
}

function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

function validateProcessId(value: number): void {
	if (!Number.isSafeInteger(value) || value <= 1 || value > 2_147_483_647) {
		throw new Error("The macOS updater process identity is invalid.");
	}
}

async function runOwnedProcess(
	command: string,
	arguments_: readonly string[],
	timeoutMs: number,
	failureMessage: string,
): Promise<void> {
	const result = await captureOwnedProcess(
		command,
		arguments_,
		timeoutMs,
		32_768,
	);
	if (result.exitCode !== 0) throw new Error(failureMessage);
}

async function captureOwnedProcess(
	command: string,
	arguments_: readonly string[],
	timeoutMs: number,
	maxOutputBytes: number,
): Promise<{ exitCode: number | null; stdout: string }> {
	validatePositiveTimeout(timeoutMs);
	return new Promise((resolveResult, rejectResult) => {
		const child = spawn(command, [...arguments_], {
			stdio: ["ignore", "pipe", "ignore"],
			shell: false,
			env: { ...process.env, LC_ALL: "C", LANG: "C" },
		});
		const chunks: Buffer[] = [];
		let bytes = 0;
		let timedOut = false;
		let processError: Error | null = null;
		child.stdout?.on("data", (chunk: Buffer) => {
			bytes += chunk.byteLength;
			if (bytes > maxOutputBytes) {
				processError = new Error(
					"The macOS updater subprocess output is invalid.",
				);
				child.kill("SIGKILL");
				return;
			}
			chunks.push(chunk);
		});
		child.once("error", (error) => {
			processError = error;
		});
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.once("close", (exitCode) => {
			clearTimeout(timer);
			if (timedOut) {
				rejectResult(new Error("The macOS updater subprocess timed out."));
			} else if (processError !== null) {
				rejectResult(processError);
			} else {
				resolveResult({
					exitCode,
					stdout: Buffer.concat(chunks).toString("utf8"),
				});
			}
		});
	});
}

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}

function validatePositiveTimeout(value: number): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error("The macOS update timeout is invalid.");
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function promiseWithTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	message: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(message)), timeoutMs);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

export function macUpdateInstallerHelperSource(): string {
	return String.raw`import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, lstat, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { dlopen, FFIType } from "bun:ffi";

const PLAN_SCHEMA = "whalehall.macos-install-plan.v1";
const READY_SCHEMA = "whalehall.macos-install-ready.v1";
const RESULT_SCHEMA = "whalehall.macos-install-result.v1";
const PROCESS_WAIT_MS = 105000;
const TOTAL_DEADLINE_MS = 120000;
const LAUNCH_HEALTH_MS = 2000;

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

function exactKeys(value, expected) {
  return Object.keys(value).sort().join("\0") === expected.slice().sort().join("\0");
}

function validPid(value) {
  return Number.isSafeInteger(value) && value > 1 && value <= 2147483647;
}

function validStartIdentity(value) {
  return typeof value === "string" && /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(value);
}

async function capture(command, args, timeoutMs) {
  return await new Promise((resolveCapture, rejectCapture) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], shell: false, env: { ...process.env, LC_ALL: "C", LANG: "C" } });
    const chunks = [];
    let size = 0;
    let failure = null;
    let timedOut = false;
    child.stdout.on("data", (chunk) => {
      size += chunk.byteLength;
      if (size > 1024) {
        failure = new Error("process identity output exceeded its bound");
        child.kill("SIGKILL");
      } else {
        chunks.push(chunk);
      }
    });
    child.once("error", (error) => { failure = error; });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) rejectCapture(new Error("process identity query timed out"));
      else if (failure) rejectCapture(failure);
      else resolveCapture({ code, stdout: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

async function processIdentity(pid) {
  const result = await capture("/bin/ps", ["-p", String(pid), "-o", "lstart="], 5000);
  if (result.code !== 0) return null;
  const identity = result.stdout.trim().replace(/\s+/g, " ");
  if (!validStartIdentity(identity)) throw new Error("invalid process identity");
  return identity;
}

async function atomicSwap(firstPath, secondPath) {
  const firstValue = await lstat(firstPath);
  const secondValue = await lstat(secondPath);
  if (!firstValue.isDirectory() || firstValue.isSymbolicLink() || !secondValue.isDirectory() || secondValue.isSymbolicLink()) throw new Error("swap paths are not trusted directories");
  const volumes = await Promise.all([stat(dirname(firstPath)), stat(dirname(secondPath))]);
  if (volumes[0].dev !== volumes[1].dev) throw new Error("swap paths cross volumes");
  const library = dlopen("/usr/lib/libSystem.B.dylib", { renameatx_np: { args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring, FFIType.u32], returns: FFIType.i32 } });
  try {
    const first = new TextEncoder().encode(firstPath + "\0");
    const second = new TextEncoder().encode(secondPath + "\0");
    if (library.symbols.renameatx_np(-2, first, -2, second, 2) !== 0) throw new Error("atomic swap failed");
  } finally {
    library.close();
  }
}

async function startAndProbe(launcherPath, deadline) {
  if (Date.now() + LAUNCH_HEALTH_MS >= deadline) throw new Error("launcher health deadline exhausted");
  await access(launcherPath, fsConstants.X_OK);
  return await new Promise((resolveLaunch, rejectLaunch) => {
    const child = spawn(launcherPath, [], { cwd: dirname(launcherPath), detached: true, stdio: "ignore", shell: false });
    let settled = false;
    let spawned = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectLaunch(error);
      else { child.unref(); resolveLaunch(child.pid); }
    };
    child.once("spawn", () => { spawned = true; });
    child.once("error", (error) => finish(error));
    child.once("close", () => finish(new Error(spawned ? "launcher exited during health probe" : "launcher did not start")));
    const timer = setTimeout(() => finish(), LAUNCH_HEALTH_MS);
  });
}

async function writeAtomicJson(path, value) {
  const temporary = path + ".tmp-" + process.pid;
  await writeFile(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

function validatePlan(value, planPath) {
  const keys = ["schemaVersion", "transactionId", "readyNonce", "mainProcessId", "mainProcessStartIdentity", "launcherProcessId", "launcherProcessStartIdentity", "currentAppPath", "bundleName"];
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, keys)) throw new Error("invalid plan shape");
  if (value.schemaVersion !== PLAN_SCHEMA || !/^[a-f0-9]{32}$/.test(value.transactionId) || !/^[a-f0-9]{32}$/.test(value.readyNonce)) throw new Error("invalid plan authority");
  if (!validPid(value.mainProcessId) || !validPid(value.launcherProcessId) || value.mainProcessId === value.launcherProcessId) throw new Error("invalid plan process ids");
  if (!validStartIdentity(value.mainProcessStartIdentity) || !validStartIdentity(value.launcherProcessStartIdentity)) throw new Error("invalid plan process identities");
  if (typeof value.bundleName !== "string" || !value.bundleName.endsWith(".app") || value.bundleName.length <= 4 || value.bundleName.length > 255 || value.bundleName.trim() !== value.bundleName || /[\\/\0\u0000-\u001f\u007f]/.test(value.bundleName)) throw new Error("invalid plan bundle name");
  if (typeof value.currentAppPath !== "string" || !isAbsolute(value.currentAppPath) || resolve(value.currentAppPath) !== value.currentAppPath || basename(value.currentAppPath) !== value.bundleName) throw new Error("invalid plan app path");
  const transactionRoot = join(dirname(value.currentAppPath), ".whalehall-update-" + value.transactionId);
  if (planPath !== join(transactionRoot, "plan.json")) throw new Error("plan path is not derived");
  return {
    plan: value,
    transactionRoot,
    candidateAppPath: join(transactionRoot, "candidate-root", value.bundleName),
    backupAppPath: join(transactionRoot, "backup.app"),
    failedAppPath: join(transactionRoot, "failed-candidate.app"),
    readyPath: join(transactionRoot, "armed.json"),
    resultPath: join(transactionRoot, "result.json"),
    launcherPath: join(value.currentAppPath, "Contents", "MacOS", "launcher")
  };
}

async function validatePaths(paths) {
  const root = await lstat(paths.transactionRoot);
  const current = await lstat(paths.plan.currentAppPath);
  const candidate = await lstat(paths.candidateAppPath);
  if (!root.isDirectory() || root.isSymbolicLink() || await realpath(paths.transactionRoot) !== paths.transactionRoot) throw new Error("untrusted transaction root");
  if (!current.isDirectory() || current.isSymbolicLink() || await realpath(paths.plan.currentAppPath) !== paths.plan.currentAppPath) throw new Error("untrusted current app");
  if (!candidate.isDirectory() || candidate.isSymbolicLink() || await realpath(paths.candidateAppPath) !== paths.candidateAppPath) throw new Error("untrusted candidate app");
  const volumes = await Promise.all([stat(paths.plan.currentAppPath), stat(paths.candidateAppPath)]);
  if (volumes[0].dev !== volumes[1].dev) throw new Error("candidate crosses volumes");
  await access(paths.launcherPath, fsConstants.X_OK);
  await access(join(paths.candidateAppPath, "Contents", "MacOS", "launcher"), fsConstants.X_OK);
}

async function waitForOwnedProcesses(plan, deadline) {
  const processDeadline = Math.min(deadline - 15000, Date.now() + PROCESS_WAIT_MS);
  while (Date.now() < processDeadline) {
    const identities = await Promise.all([processIdentity(plan.mainProcessId), processIdentity(plan.launcherProcessId)]);
    const mainExited = identities[0] === null || identities[0] !== plan.mainProcessStartIdentity;
    const launcherExited = identities[1] === null || identities[1] !== plan.launcherProcessStartIdentity;
    if (mainExited && launcherExited) return;
    await delay(100);
  }
  throw new Error("owned processes did not exit before the deadline");
}

async function install(paths, deadline) {
  const newLauncher = join(paths.candidateAppPath, "Contents", "MacOS", "launcher");
  try {
    await atomicSwap(paths.plan.currentAppPath, paths.candidateAppPath);
  } catch (error) {
    let restoredPid = null;
    try { restoredPid = await startAndProbe(paths.launcherPath, deadline); } catch {}
    return { state: "failed_before_swap", restoredPid, error: error instanceof Error ? error.message : "swap failed" };
  }

  try {
    await rename(paths.candidateAppPath, paths.backupAppPath);
  } catch (error) {
    try {
      await atomicSwap(paths.plan.currentAppPath, paths.candidateAppPath);
      const restoredPid = await startAndProbe(paths.launcherPath, deadline);
      return { state: "rolled_back", restoredPid, error: error instanceof Error ? error.message : "backup move failed" };
    } catch (rollbackError) {
      return { state: "rollback_failed", restoredPid: null, error: rollbackError instanceof Error ? rollbackError.message : "rollback failed" };
    }
  }

  try {
    const launchedPid = await startAndProbe(paths.launcherPath, deadline);
    return { state: "installed", launchedPid };
  } catch (error) {
    try {
      await atomicSwap(paths.plan.currentAppPath, paths.backupAppPath);
      try { await rename(paths.backupAppPath, paths.failedAppPath); } catch {}
      const restoredPid = await startAndProbe(paths.launcherPath, deadline);
      return { state: "rolled_back", restoredPid, error: error instanceof Error ? error.message : "new launcher failed" };
    } catch (rollbackError) {
      let restoredPid = null;
      try { restoredPid = await startAndProbe(join(paths.backupAppPath, "Contents", "MacOS", "launcher"), deadline); } catch {}
      return { state: "rollback_failed", restoredPid, error: rollbackError instanceof Error ? rollbackError.message : "rollback failed" };
    }
  }
}

async function main() {
  if (process.platform !== "darwin") throw new Error("macOS helper used on another platform");
  const rawPlanPath = process.argv[2];
  if (typeof rawPlanPath !== "string" || !isAbsolute(rawPlanPath)) throw new Error("missing absolute plan path");
  const planPath = resolve(rawPlanPath);
  const raw = JSON.parse(await readFile(planPath, "utf8"));
  const paths = validatePlan(raw, planPath);
  await validatePaths(paths);
  if (process.ppid !== paths.plan.mainProcessId) throw new Error("helper parent is not the planned main process");
  const identities = await Promise.all([processIdentity(paths.plan.mainProcessId), processIdentity(paths.plan.launcherProcessId)]);
  if (identities[0] !== paths.plan.mainProcessStartIdentity || identities[1] !== paths.plan.launcherProcessStartIdentity) throw new Error("planned process identity changed before arming");
  const deadline = Date.now() + TOTAL_DEADLINE_MS;
  await writeAtomicJson(paths.readyPath, { schemaVersion: READY_SCHEMA, transactionId: paths.plan.transactionId, nonce: paths.plan.readyNonce, state: "armed", helperProcessId: process.pid });
  let result;
  try {
    await waitForOwnedProcesses(paths.plan, deadline);
    result = await install(paths, deadline);
  } catch (error) {
    result = { state: "aborted", error: error instanceof Error ? error.message : "installer aborted" };
  }
  await writeAtomicJson(paths.resultPath, { schemaVersion: RESULT_SCHEMA, transactionId: paths.plan.transactionId, ...result });
  if (result.state !== "installed") process.exitCode = 1;
}

await main();
`;
}
