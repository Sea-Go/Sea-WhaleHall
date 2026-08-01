import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("runtime has no dependencies or networking imports", async () => {
  const packageRoot = path.resolve(__dirname, "../..");
  const manifest = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
  };
  assert.equal(manifest.dependencies, undefined);

  const runtimeFiles = [
    "config.ts",
    "contracts.ts",
    "event-builder.ts",
    "extension.ts",
    "path-policy.ts",
    "spool.ts",
  ];
  for (const file of runtimeFiles) {
    const source = await readFile(
      path.join(packageRoot, "src", file),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /from\s+["'](?:node:)?(?:http|https|http2|net|tls|dgram|dns)["']/u,
      file,
    );
    assert.doesNotMatch(source, /\bfetch\s*\(/u, file);
  }
});
