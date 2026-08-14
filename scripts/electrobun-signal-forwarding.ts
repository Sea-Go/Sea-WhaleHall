import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	WHALEHALL_LIFECYCLE_SIGNAL_MESSAGE_TYPE,
	WHALEHALL_LIFECYCLE_SIGNAL_MESSAGE_VERSION,
} from "../src/shared/app-lifecycle-signal";

export {
	WHALEHALL_LIFECYCLE_SIGNAL_MESSAGE_TYPE,
	WHALEHALL_LIFECYCLE_SIGNAL_MESSAGE_VERSION,
};

export const ELECTROBUN_VENDOR_SIGNAL_SENTINEL = `  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => {});
  new Worker(appEntrypointPath, {});`;

export const ELECTROBUN_WHALEHALL_LEGACY_SIGNAL_FORWARDING = `  const whaleHallAppWorker = new Worker(appEntrypointPath, {});
  const forwardWhaleHallLifecycleSignal = (signal) => {
    whaleHallAppWorker.postMessage({
      type: "${WHALEHALL_LIFECYCLE_SIGNAL_MESSAGE_TYPE}",
      version: ${WHALEHALL_LIFECYCLE_SIGNAL_MESSAGE_VERSION},
      signal
    });
  };
  process.on("SIGINT", () => forwardWhaleHallLifecycleSignal("SIGINT"));
  process.on("SIGTERM", () => forwardWhaleHallLifecycleSignal("SIGTERM"));`;

export const ELECTROBUN_WHALEHALL_SIGNAL_FORWARDING = `  let whaleHallAppWorker = null;
  let pendingWhaleHallLifecycleSignal = null;
  const forwardWhaleHallLifecycleSignal = (signal) => {
    if (whaleHallAppWorker === null) {
      pendingWhaleHallLifecycleSignal ??= signal;
      return;
    }
    whaleHallAppWorker.postMessage({
      type: "${WHALEHALL_LIFECYCLE_SIGNAL_MESSAGE_TYPE}",
      version: ${WHALEHALL_LIFECYCLE_SIGNAL_MESSAGE_VERSION},
      signal
    });
  };
  process.on("SIGINT", () => forwardWhaleHallLifecycleSignal("SIGINT"));
  process.on("SIGTERM", () => forwardWhaleHallLifecycleSignal("SIGTERM"));
  whaleHallAppWorker = new Worker(appEntrypointPath, {});
  if (pendingWhaleHallLifecycleSignal !== null) {
    const pendingSignal = pendingWhaleHallLifecycleSignal;
    pendingWhaleHallLifecycleSignal = null;
    forwardWhaleHallLifecycleSignal(pendingSignal);
  }`;

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const electrobunRuntimeMainPath = join(
	projectRoot,
	"node_modules",
	"electrobun",
	"dist",
	"main.js",
);

export type ElectrobunSignalForwardingRewrite = {
	readonly source: string;
	readonly changed: boolean;
};

/**
 * Rewrites only Electrobun 1.18.1's exact launcher signal block.
 *
 * The already-patched form is accepted so repeated and concurrent pre-build
 * hooks are harmless. Every other shape fails closed instead of silently
 * producing a package whose application Worker cannot observe OS termination.
 */
export function rewriteElectrobunSignalForwarding(
	source: string,
): ElectrobunSignalForwardingRewrite {
	const { canonical, lineEnding } = canonicalSignalSource(source);
	const vendorCount = countExact(canonical, ELECTROBUN_VENDOR_SIGNAL_SENTINEL);
	const patchedCount = countExact(
		canonical,
		ELECTROBUN_WHALEHALL_SIGNAL_FORWARDING,
	);
	const legacyCount = countExact(
		canonical,
		ELECTROBUN_WHALEHALL_LEGACY_SIGNAL_FORWARDING,
	);
	if (
		patchedCount === 0 &&
		((vendorCount === 1 && legacyCount === 0) ||
			(vendorCount === 0 && legacyCount === 1))
	) {
		const rewritten = canonical.replace(
			vendorCount === 1
				? ELECTROBUN_VENDOR_SIGNAL_SENTINEL
				: ELECTROBUN_WHALEHALL_LEGACY_SIGNAL_FORWARDING,
			ELECTROBUN_WHALEHALL_SIGNAL_FORWARDING,
		);
		const rendered = renderSignalSource(rewritten, lineEnding);
		assertElectrobunSignalForwarding(rendered);
		return { source: rendered, changed: true };
	}
	if (vendorCount === 0 && legacyCount === 0 && patchedCount === 1) {
		return { source, changed: false };
	}
	throw new Error(
		"Electrobun runtime signal block did not match the one exact supported " +
			`(vendor=${vendorCount}, legacy=${legacyCount}, whalehall=${patchedCount}).`,
	);
}

export function assertElectrobunSignalForwarding(source: string): void {
	const { canonical } = canonicalSignalSource(source);
	const vendorCount = countExact(canonical, ELECTROBUN_VENDOR_SIGNAL_SENTINEL);
	const patchedCount = countExact(
		canonical,
		ELECTROBUN_WHALEHALL_SIGNAL_FORWARDING,
	);
	const legacyCount = countExact(
		canonical,
		ELECTROBUN_WHALEHALL_LEGACY_SIGNAL_FORWARDING,
	);
	if (vendorCount !== 0 || legacyCount !== 0 || patchedCount !== 1) {
		throw new Error(
			"Electrobun runtime is missing the one exact WhaleHall signal forwarder " +
				`(vendor=${vendorCount}, legacy=${legacyCount}, whalehall=${patchedCount}).`,
		);
	}
}

export function assertElectrobunSignalForwardingFile(path: string): void {
	const stats = lstatSync(path);
	if (!stats.isFile() || stats.isSymbolicLink()) {
		throw new Error(
			`Electrobun runtime main is not a regular non-link file: ${path}`,
		);
	}
	assertElectrobunSignalForwarding(readFileSync(path, "utf8"));
}

export function verifyMacWrapperSignalForwardingFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
): void {
	if (environment.ELECTROBUN_OS !== "macos") return;
	const bundlePath = requiredEnvironment(
		environment,
		"ELECTROBUN_WRAPPER_BUNDLE_PATH",
	);
	assertElectrobunSignalForwardingFile(
		join(bundlePath, "Contents", "Resources", "main.js"),
	);
}

/**
 * Ensures the tracked Electrobun package patch is present before its CLI copies
 * dist/main.js into the application and updater payloads. The atomic fallback
 * supports an existing, pre-install node_modules directory; concurrent builds
 * can only race to install the same byte-identical result.
 */
export function ensureElectrobunSignalForwarding(
	path = electrobunRuntimeMainPath,
): void {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const stats = lstatSync(path);
		if (!stats.isFile() || stats.isSymbolicLink()) {
			throw new Error(
				"Electrobun runtime main must be a regular non-link file.",
			);
		}
		const current = readFileSync(path, "utf8");
		const rewritten = rewriteElectrobunSignalForwarding(current);
		if (!rewritten.changed) return;

		const temporaryPath = `${path}.whalehall-${process.pid}-${crypto.randomUUID()}.tmp`;
		let descriptor: number | null = null;
		try {
			descriptor = openSync(temporaryPath, "wx", stats.mode & 0o777);
			writeFileSync(descriptor, rewritten.source, "utf8");
			fsyncSync(descriptor);
			closeSync(descriptor);
			descriptor = null;

			// If another build won the race, validate its result instead of restoring
			// or overwriting an unexpected third-party change.
			const observed = readFileSync(path, "utf8");
			if (observed !== current) {
				assertElectrobunSignalForwarding(observed);
				return;
			}
			renameSync(temporaryPath, path);
			assertElectrobunSignalForwarding(readFileSync(path, "utf8"));
			return;
		} finally {
			if (descriptor !== null) closeSync(descriptor);
			if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
		}
	}
	throw new Error(
		"Electrobun runtime signal patch could not be installed atomically.",
	);
}

function countExact(source: string, value: string): number {
	let count = 0;
	let offset = 0;
	for (;;) {
		const index = source.indexOf(value, offset);
		if (index < 0) return count;
		count += 1;
		offset = index + value.length;
	}
}

function canonicalSignalSource(source: string): {
	canonical: string;
	lineEnding: "\n" | "\r\n";
} {
	const withoutCrLf = source.replaceAll("\r\n", "");
	if (withoutCrLf.includes("\r")) {
		throw new Error(
			"Electrobun runtime main contains an unsupported line ending.",
		);
	}
	const hasCrLf = source.includes("\r\n");
	if (hasCrLf && withoutCrLf.includes("\n")) {
		const patchedCount = countExact(
			source,
			ELECTROBUN_WHALEHALL_SIGNAL_FORWARDING,
		);
		const outsidePatchedBlock = source.replace(
			ELECTROBUN_WHALEHALL_SIGNAL_FORWARDING,
			"",
		);
		const outsideWithoutCrLf = outsidePatchedBlock.replaceAll("\r\n", "");
		if (
			patchedCount !== 1 ||
			outsideWithoutCrLf.includes("\n") ||
			outsideWithoutCrLf.includes("\r")
		) {
			throw new Error("Electrobun runtime main contains mixed line endings.");
		}
		// Bun's Windows patchedDependencies implementation preserves CRLF in the
		// vendor file while writing the one tracked patch hunk with LF. Accept only
		// that byte-exact mixed form; arbitrary mixed input remains fail-closed.
		const uniformCrLf = source.replace(
			ELECTROBUN_WHALEHALL_SIGNAL_FORWARDING,
			ELECTROBUN_WHALEHALL_SIGNAL_FORWARDING.replaceAll("\n", "\r\n"),
		);
		return {
			canonical: uniformCrLf.replaceAll("\r\n", "\n"),
			lineEnding: "\r\n",
		};
	}
	return {
		canonical: hasCrLf ? source.replaceAll("\r\n", "\n") : source,
		lineEnding: hasCrLf ? "\r\n" : "\n",
	};
}

function renderSignalSource(source: string, lineEnding: "\n" | "\r\n"): string {
	return lineEnding === "\r\n" ? source.replaceAll("\n", "\r\n") : source;
}

function requiredEnvironment(
	environment: NodeJS.ProcessEnv,
	name: string,
): string {
	const value = environment[name]?.trim();
	if (!value) throw new Error(`${name} is required.`);
	return value;
}
