import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SPOOL_DIRECTORY_NAME,
  type BuildEditEventInput,
} from "../contracts.js";
import { buildEditEvent } from "../event-builder.js";
import { AtomicJsonlSpool } from "../spool.js";

function buildFixture(
  occurredAtMs: number,
  text = "x",
  includeText = false,
) {
  const fixture: BuildEditEventInput = {
    sourceInstanceId: "spool-test",
    workspaceUri: "file:///workspace",
    relativePath: "src/index.ts",
    languageId: "typescript",
    documentVersion: occurredAtMs,
    occurredAtMs,
    observedAtMs: occurredAtMs,
    includeText,
    contentChanges: [
      {
        rangeOffset: 0,
        rangeLength: 0,
        text,
      },
    ],
  };
  return buildEditEvent(fixture);
}

test("segments are atomically published with private permissions", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "whalehall-spool-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { force: true, recursive: true });
  });

  const spool = new AtomicJsonlSpool(root);
  spool.enqueue(buildFixture(1_724_000_000_000));
  await spool.flush();

  const spoolDirectory = path.join(root, SPOOL_DIRECTORY_NAME);
  const names = await readdir(spoolDirectory);
  const segments = names.filter((name) => name.endsWith(".jsonl"));
  assert.equal(segments.length, 1);
  assert.equal(names.some((name) => name.startsWith(".tmp-")), false);

  const segment = path.join(spoolDirectory, segments[0] as string);
  const lines = (await readFile(segment, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(
    (JSON.parse(lines[0] as string) as { schemaVersion: string })
      .schemaVersion,
    "whalehall-vscode-edit.v1",
  );
  if (process.platform !== "win32") {
    assert.equal((await stat(segment)).mode & 0o777, 0o600);
    assert.equal((await stat(spoolDirectory)).mode & 0o777, 0o700);
  }

  await spool.close();
});

test("spool rotation bounds sealed file count", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "whalehall-rotation-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { force: true, recursive: true });
  });

  const spool = new AtomicJsonlSpool(root, {
    limits: {
      flushIntervalMs: 60_000,
      maxEventLineBytes: 4_096,
      maxEventsPerSegment: 1,
      maxSegmentBytes: 4_096,
      maxSpoolSegments: 2,
      maxSpoolBytes: 8_192,
    },
  });
  spool.enqueue(buildFixture(1_724_000_000_001));
  spool.enqueue(buildFixture(1_724_000_000_002));
  spool.enqueue(buildFixture(1_724_000_000_003));
  await spool.flush();

  const status = await spool.status();
  assert.equal(status.segmentCount, 2);
  const names = (
    await readdir(path.join(root, SPOOL_DIRECTORY_NAME))
  ).filter((name) => name.endsWith(".jsonl"));
  assert.equal(
    names.some((name) => name.includes("1724000000001")),
    false,
  );
  await spool.close();
});

test("oversized JSONL records are rejected before touching disk", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "whalehall-limit-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { force: true, recursive: true });
  });
  const spool = new AtomicJsonlSpool(root, {
    limits: {
      maxEventLineBytes: 256,
      maxSegmentBytes: 256,
    },
  });

  assert.throws(
    () => spool.enqueue(buildFixture(1_724_000_000_000, "x".repeat(1000), true)),
    /exceeds/u,
  );
  assert.equal((await spool.status()).initialized, false);
  await spool.close();
});

test("writer fails closed when its bounded in-memory queue is saturated", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "whalehall-queue-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { force: true, recursive: true });
  });
  const spool = new AtomicJsonlSpool(root, {
    limits: {
      flushIntervalMs: 60_000,
      maxEventLineBytes: 4_096,
      maxEventsPerSegment: 1,
      maxSegmentBytes: 4_096,
      maxQueuedSegments: 1,
    },
  });

  spool.enqueue(buildFixture(1_724_000_000_001));
  assert.throws(
    () => spool.enqueue(buildFixture(1_724_000_000_002)),
    /in-memory queue limit/u,
  );
  await spool.close();
});
