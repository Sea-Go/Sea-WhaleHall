import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isSafeDocumentCandidate,
  resolveCanonicalWorkspaceRelativePath,
  resolveWorkspaceRelativePath,
  validateBridgeDirectory,
} from "../path-policy.js";

test("bridge directory must be explicit, absolute, and traversal-free", () => {
  assert.equal(validateBridgeDirectory("").ok, false);
  assert.equal(validateBridgeDirectory("./bridge").ok, false);
  assert.equal(validateBridgeDirectory("/tmp/a/../bridge").ok, false);
  assert.equal(validateBridgeDirectory("//server/share/bridge").ok, false);
  assert.equal(validateBridgeDirectory("\\\\server\\share\\bridge").ok, false);
  assert.equal(validateBridgeDirectory(path.parse("/").root).ok, false);

  const valid = validateBridgeDirectory("/tmp/whalehall-vscode-test");
  assert.deepEqual(valid, {
    ok: true,
    path: path.normalize("/tmp/whalehall-vscode-test"),
  });
});

test("only workspace-contained paths become portable relative paths", () => {
  assert.deepEqual(
    resolveWorkspaceRelativePath(
      "/workspace/project",
      "/workspace/project/src/index.ts",
    ),
    { ok: true, path: "src/index.ts" },
  );
  assert.equal(
    resolveWorkspaceRelativePath(
      "/workspace/project",
      "/workspace/other/secret.ts",
    ).ok,
    false,
  );
});

test("canonical containment rejects a workspace symlink to an external file", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "whalehall-path-policy-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const workspace = path.join(root, "workspace");
  const external = path.join(root, "outside.ts");
  const link = path.join(workspace, "linked.ts");
  await mkdir(workspace);
  await writeFile(external, "private");
  try {
    await symlink(external, link, "file");
  } catch (error) {
    t.skip(`symlink creation is unavailable: ${String(error)}`);
    return;
  }

  assert.equal(
    (await resolveCanonicalWorkspaceRelativePath(workspace, link)).ok,
    false,
  );

  const local = path.join(workspace, "src", "index.ts");
  await mkdir(path.dirname(local));
  await writeFile(local, "safe");
  assert.deepEqual(
    await resolveCanonicalWorkspaceRelativePath(workspace, local),
    {
      ok: true,
      path: "src/index.ts",
      workspaceRoot: await realpath(workspace),
    },
  );
});

test("unsafe schemes, untitled buffers, and secret-like files are excluded", () => {
  const safeBase = {
    scheme: "file",
    isUntitled: false,
    languageId: "typescript",
    relativePath: "src/index.ts",
  };
  assert.equal(isSafeDocumentCandidate(safeBase), true);

  for (const scheme of [
    "untitled",
    "output",
    "debug",
    "vscode-userdata",
    "git",
  ]) {
    assert.equal(
      isSafeDocumentCandidate({ ...safeBase, scheme }),
      false,
      scheme,
    );
  }

  assert.equal(
    isSafeDocumentCandidate({ ...safeBase, isUntitled: true }),
    false,
  );
  assert.equal(
    isSafeDocumentCandidate({
      ...safeBase,
      relativePath: ".env.production",
    }),
    false,
  );
  assert.equal(
    isSafeDocumentCandidate({
      ...safeBase,
      relativePath: ".ssh/id_rsa",
    }),
    false,
  );
  assert.equal(
    isSafeDocumentCandidate({
      ...safeBase,
      relativePath: "config/client.key",
    }),
    false,
  );
  assert.equal(
    isSafeDocumentCandidate({
      ...safeBase,
      relativePath: "config/private.pem",
    }),
    false,
  );
  assert.equal(
    isSafeDocumentCandidate({ ...safeBase, languageId: "dotenv" }),
    false,
  );
});
