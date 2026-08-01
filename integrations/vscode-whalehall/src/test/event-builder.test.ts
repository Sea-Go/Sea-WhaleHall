import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_CHANGES_PER_EVENT,
  MAX_EVENT_LINE_BYTES,
  MAX_INSERTED_TEXT_CODEPOINTS_PER_CHANGE,
  type BuildEditEventInput,
} from "../contracts.js";
import { buildEditEvent } from "../event-builder.js";

function input(
  overrides: Partial<BuildEditEventInput> = {},
): BuildEditEventInput {
  return {
    sourceInstanceId: "source-fixture",
    workspaceUri: "file:///workspace/private-absolute-path",
    relativePath: "src/example.ts",
    languageId: "typescript",
    documentVersion: 7,
    occurredAtMs: 1_724_000_000_000,
    observedAtMs: 1_724_000_000_001,
    includeText: false,
    contentChanges: [
      {
        rangeOffset: 12,
        rangeLength: 4,
        text: "hello",
      },
    ],
    ...overrides,
  };
}

test("metadata mode emits counts without inserted or deleted text", () => {
  const event = buildEditEvent(input());

  assert.equal(event.schemaVersion, "whalehall-vscode-edit.v1");
  assert.match(event.eventId, /^vse1_[0-9a-f]{32}$/u);
  assert.match(event.payload.workspaceId, /^wsp1_[0-9a-f]{32}$/u);
  assert.equal(event.sensitivity, "metadata");
  assert.deepEqual(event.payload.document, {
    relativePath: "src/example.ts",
    languageId: "typescript",
    version: 7,
  });
  assert.deepEqual(event.payload.changes, [
    {
      rangeOffset: 12,
      deletedChars: 4,
      insertedChars: 5,
    },
  ]);
  assert.equal(
    JSON.stringify(event).includes("private-absolute-path"),
    false,
  );
});

test("content mode includes only bounded inserted text", () => {
  const inserted = "🐋".repeat(
    MAX_INSERTED_TEXT_CODEPOINTS_PER_CHANGE + 50,
  );
  const event = buildEditEvent(
    input({
      includeText: true,
      contentChanges: [
        {
          rangeOffset: 0,
          rangeLength: 99,
          text: inserted,
        },
      ],
    }),
  );
  const change = event.payload.changes[0];

  assert.equal(event.sensitivity, "content");
  assert.equal(change?.deletedChars, 99);
  assert.equal(change?.insertedChars, inserted.length);
  assert.equal(
    Array.from(change?.insertedText ?? "").length,
    MAX_INSERTED_TEXT_CODEPOINTS_PER_CHANGE,
  );
  assert.equal(change?.insertedTextTruncated, true);
  assert.equal(JSON.stringify(event).includes("deleted text"), false);
});

test("change arrays are bounded and truncation is explicit", () => {
  const contentChanges = Array.from(
    { length: MAX_CHANGES_PER_EVENT + 5 },
    (_, index) => ({
      rangeOffset: index,
      rangeLength: 0,
      text: "x",
    }),
  );
  const event = buildEditEvent(input({ contentChanges }));

  assert.equal(event.payload.changeCount, MAX_CHANGES_PER_EVENT + 5);
  assert.equal(event.payload.emittedChangeCount, MAX_CHANGES_PER_EVENT);
  assert.equal(event.payload.changes.length, MAX_CHANGES_PER_EVENT);
  assert.equal(event.payload.changesTruncated, true);
});

test("escaped inserted text remains below the JSONL line ceiling", () => {
  const event = buildEditEvent(
    input({
      includeText: true,
      contentChanges: Array.from({ length: MAX_CHANGES_PER_EVENT }, () => ({
        rangeOffset: 0,
        rangeLength: 0,
        text: "\0".repeat(2_000),
      })),
    }),
  );
  assert.ok(
    Buffer.byteLength(`${JSON.stringify(event)}\n`, "utf8") <
      MAX_EVENT_LINE_BYTES,
  );
  assert.equal(
    event.payload.changes.some(
      (change) => change.insertedTextTruncated === true,
    ),
    true,
  );
});

test("event identifiers are stable for the same safe delta", () => {
  const first = buildEditEvent(input());
  const second = buildEditEvent(input({ observedAtMs: 1_724_000_009_999 }));
  assert.equal(first.eventId, second.eventId);
});

test("event builder refuses absolute and traversing document paths", () => {
  assert.throws(
    () => buildEditEvent(input({ relativePath: "/etc/passwd" })),
    /workspace-relative/u,
  );
  assert.throws(
    () => buildEditEvent(input({ relativePath: "../secret.txt" })),
    /workspace-relative/u,
  );
});
