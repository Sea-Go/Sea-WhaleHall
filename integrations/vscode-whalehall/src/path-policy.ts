import path from "node:path";
import { realpath } from "node:fs/promises";

const MAX_RELATIVE_PATH_LENGTH = 1_024;
const FORBIDDEN_DIRECTORY_NAMES = new Set([
  ".aws",
  ".azure",
  ".git",
  ".gnupg",
  ".kube",
  ".ssh",
]);
const FORBIDDEN_EXACT_NAMES = new Set([
  ".env",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "credentials",
  "credentials.json",
  "id_dsa",
  "id_ed25519",
  "id_ecdsa",
  "id_rsa",
  "password",
  "passwords",
  "secret",
  "secrets",
  "token",
  "tokens",
]);
const FORBIDDEN_SECRET_EXTENSIONS = new Set([
  ".jks",
  ".key",
  ".p12",
  ".pem",
  ".pfx",
  ".pkcs12",
]);
const FORBIDDEN_LANGUAGE_IDS = new Set([
  "dotenv",
  "password",
]);

export type PathValidationResult =
  | { ok: true; path: string }
  | { ok: false; reason: string };

export type CanonicalWorkspacePathValidationResult =
  | { ok: true; path: string; workspaceRoot: string }
  | { ok: false; reason: string };

function hasParentTraversal(rawPath: string): boolean {
  return rawPath.split(/[\\/]+/u).some((segment) => segment === "..");
}

export function validateBridgeDirectory(
  configuredPath: string,
): PathValidationResult {
  const candidate = configuredPath.trim();
  if (candidate.length === 0) {
    return { ok: false, reason: "bridgeDirectory is not configured" };
  }
  if (candidate.includes("\0")) {
    return { ok: false, reason: "bridgeDirectory contains a null byte" };
  }
  if (hasParentTraversal(candidate)) {
    return {
      ok: false,
      reason: "bridgeDirectory must not contain parent traversal",
    };
  }
  if (candidate.startsWith("\\\\") || candidate.startsWith("//")) {
    return {
      ok: false,
      reason: "bridgeDirectory must not use a network or device path",
    };
  }
  if (!path.isAbsolute(candidate)) {
    return {
      ok: false,
      reason: "bridgeDirectory must be an absolute local path",
    };
  }

  const normalized = path.normalize(candidate);
  if (normalized === path.parse(normalized).root) {
    return {
      ok: false,
      reason: "bridgeDirectory must not be a filesystem root",
    };
  }

  return { ok: true, path: normalized };
}

export function resolveWorkspaceRelativePath(
  workspaceRoot: string,
  documentPath: string,
): PathValidationResult {
  if (
    workspaceRoot.includes("\0") ||
    documentPath.includes("\0") ||
    !path.isAbsolute(workspaceRoot) ||
    !path.isAbsolute(documentPath)
  ) {
    return { ok: false, reason: "workspace and document paths must be absolute" };
  }

  const root = path.resolve(workspaceRoot);
  const document = path.resolve(documentPath);
  const relative = path.relative(root, document);
  if (
    relative.length === 0 ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    return { ok: false, reason: "document is outside the workspace" };
  }

  const portable = relative.split(path.sep).join("/");
  if (
    portable.length > MAX_RELATIVE_PATH_LENGTH ||
    portable.split("/").some((segment) => segment === "..")
  ) {
    return { ok: false, reason: "workspace-relative path is unsafe" };
  }

  return { ok: true, path: portable };
}

/**
 * Resolves both paths before checking containment so a workspace-local
 * symlink cannot make the bridge observe a file outside the trusted root.
 * New, not-yet-materialized files fail closed until they exist on disk.
 */
export async function resolveCanonicalWorkspaceRelativePath(
  workspaceRoot: string,
  documentPath: string,
): Promise<CanonicalWorkspacePathValidationResult> {
  if (
    workspaceRoot.includes("\0") ||
    documentPath.includes("\0") ||
    !path.isAbsolute(workspaceRoot) ||
    !path.isAbsolute(documentPath)
  ) {
    return { ok: false, reason: "workspace and document paths must be absolute" };
  }

  let canonicalWorkspace: string;
  let canonicalDocument: string;
  try {
    [canonicalWorkspace, canonicalDocument] = await Promise.all([
      realpath(workspaceRoot),
      realpath(documentPath),
    ]);
  } catch {
    return {
      ok: false,
      reason: "workspace or document path cannot be resolved safely",
    };
  }

  const relative = resolveWorkspaceRelativePath(
    canonicalWorkspace,
    canonicalDocument,
  );
  return relative.ok
    ? {
        ok: true,
        path: relative.path,
        workspaceRoot: canonicalWorkspace,
      }
    : relative;
}

export function isSafeDocumentCandidate(input: {
  scheme: string;
  isUntitled: boolean;
  languageId: string;
  relativePath: string;
}): boolean {
  if (
    input.scheme !== "file" ||
    input.isUntitled ||
    FORBIDDEN_LANGUAGE_IDS.has(input.languageId.toLowerCase())
  ) {
    return false;
  }

  const portablePath = input.relativePath.replaceAll("\\", "/");
  if (
    portablePath.length === 0 ||
    portablePath.length > MAX_RELATIVE_PATH_LENGTH ||
    portablePath.startsWith("/") ||
    portablePath.split("/").some((segment) => segment === "..")
  ) {
    return false;
  }

  const segments = portablePath.toLowerCase().split("/");
  if (
    segments.some((segment) => FORBIDDEN_DIRECTORY_NAMES.has(segment))
  ) {
    return false;
  }

  const fileName = segments.at(-1);
  if (fileName === undefined) {
    return false;
  }
  if (
    fileName.startsWith(".env.") ||
    FORBIDDEN_EXACT_NAMES.has(fileName) ||
    FORBIDDEN_SECRET_EXTENSIONS.has(path.posix.extname(fileName))
  ) {
    return false;
  }

  return true;
}
