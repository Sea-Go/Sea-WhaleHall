import { createHash } from "node:crypto";
import {
  EDIT_EVENT_KIND,
  EDIT_EVENT_SCHEMA_VERSION,
  EDIT_EVENT_SOURCE,
  MAX_CHANGES_PER_EVENT,
  MAX_INSERTED_TEXT_BYTES_PER_EVENT,
  MAX_INSERTED_TEXT_CODEPOINTS_PER_CHANGE,
  MAX_INSERTED_TEXT_JSON_BYTES_PER_EVENT,
  type BuildEditEventInput,
  type SafeEditDeltaV1,
  type VscodeEditEventV1,
} from "./contracts.js";

function assertSafeInteger(
  value: number,
  field: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${field} must be a safe integer between ${minimum} and ${maximum}`,
    );
  }
}

function assertBoundedString(
  value: string,
  field: string,
  maximumLength: number,
): void {
  if (
    value.length === 0 ||
    value.length > maximumLength ||
    value.includes("\0")
  ) {
    throw new Error(`${field} is empty, oversized, or contains a null byte`);
  }
}

function assertRelativePath(value: string): void {
  assertBoundedString(value, "relativePath", 1_024);
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((segment) => segment === ".." || segment === "")
  ) {
    throw new Error("relativePath must be a normalized workspace-relative path");
  }
}

function takeBoundedInsertedText(
  value: string,
  remainingBytes: number,
  remainingJsonBytes: number,
): {
  text?: string;
  bytes: number;
  jsonBytes: number;
  truncated: boolean;
} {
  if (value.length === 0) {
    return { bytes: 0, jsonBytes: 0, truncated: false };
  }

  let result = "";
  let bytes = 0;
  let jsonBytes = 0;
  let codepoints = 0;
  let consumedUtf16Units = 0;

  for (const codepoint of value) {
    const codepointBytes = Buffer.byteLength(codepoint, "utf8");
    const codepointJsonBytes =
      Buffer.byteLength(JSON.stringify(codepoint), "utf8") - 2;
    if (
      codepoints >= MAX_INSERTED_TEXT_CODEPOINTS_PER_CHANGE ||
      bytes + codepointBytes > remainingBytes ||
      jsonBytes + codepointJsonBytes > remainingJsonBytes
    ) {
      break;
    }
    result += codepoint;
    bytes += codepointBytes;
    jsonBytes += codepointJsonBytes;
    codepoints += 1;
    consumedUtf16Units += codepoint.length;
  }

  return {
    ...(result.length > 0 ? { text: result } : {}),
    bytes,
    jsonBytes,
    truncated: consumedUtf16Units < value.length,
  };
}

function hashIdentifier(prefix: string, input: string): string {
  return `${prefix}_${createHash("sha256").update(input).digest("hex").slice(0, 32)}`;
}

export function buildEditEvent(
  input: BuildEditEventInput,
): VscodeEditEventV1 {
  assertBoundedString(input.sourceInstanceId, "sourceInstanceId", 256);
  assertBoundedString(input.workspaceUri, "workspaceUri", 16_384);
  assertRelativePath(input.relativePath);
  assertBoundedString(input.languageId, "languageId", 128);
  assertSafeInteger(input.documentVersion, "documentVersion");
  assertSafeInteger(input.occurredAtMs, "occurredAtMs", 0, 9_999_999_999_999);
  assertSafeInteger(input.observedAtMs, "observedAtMs", 0, 9_999_999_999_999);
  if (input.observedAtMs < input.occurredAtMs) {
    throw new Error("observedAtMs must not precede occurredAtMs");
  }

  const changes: SafeEditDeltaV1[] = [];
  const emittedInputs = input.contentChanges.slice(0, MAX_CHANGES_PER_EVENT);
  let remainingTextBytes = MAX_INSERTED_TEXT_BYTES_PER_EVENT;
  let remainingTextJsonBytes = MAX_INSERTED_TEXT_JSON_BYTES_PER_EVENT;

  for (const [index, change] of emittedInputs.entries()) {
    assertSafeInteger(change.rangeOffset, `contentChanges[${index}].rangeOffset`);
    assertSafeInteger(change.rangeLength, `contentChanges[${index}].rangeLength`);

    const safeChange: SafeEditDeltaV1 = {
      rangeOffset: change.rangeOffset,
      deletedChars: change.rangeLength,
      insertedChars: change.text.length,
    };

    if (input.includeText && change.text.length > 0) {
      const bounded = takeBoundedInsertedText(
        change.text,
        remainingTextBytes,
        remainingTextJsonBytes,
      );
      if (bounded.text !== undefined) {
        safeChange.insertedText = bounded.text;
      }
      if (bounded.truncated) {
        safeChange.insertedTextTruncated = true;
      }
      remainingTextBytes -= bounded.bytes;
      remainingTextJsonBytes -= bounded.jsonBytes;
    }

    changes.push(safeChange);
  }

  const workspaceId = hashIdentifier(
    "wsp1",
    `${input.sourceInstanceId}\0${input.workspaceUri}`,
  );
  const eventWithoutId = {
    schemaVersion: EDIT_EVENT_SCHEMA_VERSION,
    kind: EDIT_EVENT_KIND,
    source: EDIT_EVENT_SOURCE,
    occurredAtMs: input.occurredAtMs,
    observedAtMs: input.observedAtMs,
    sensitivity: input.includeText ? ("content" as const) : ("metadata" as const),
    payload: {
      workspaceId,
      document: {
        relativePath: input.relativePath,
        languageId: input.languageId,
        version: input.documentVersion,
      },
      changeCount: input.contentChanges.length,
      emittedChangeCount: changes.length,
      changesTruncated: input.contentChanges.length > changes.length,
      changes,
    },
  };
  const eventId = hashIdentifier(
    "vse1",
    JSON.stringify({
      sourceInstanceId: input.sourceInstanceId,
      schemaVersion: eventWithoutId.schemaVersion,
      kind: eventWithoutId.kind,
      source: eventWithoutId.source,
      occurredAtMs: eventWithoutId.occurredAtMs,
      sensitivity: eventWithoutId.sensitivity,
      payload: eventWithoutId.payload,
    }),
  );

  return {
    schemaVersion: eventWithoutId.schemaVersion,
    eventId,
    kind: eventWithoutId.kind,
    source: eventWithoutId.source,
    occurredAtMs: eventWithoutId.occurredAtMs,
    observedAtMs: eventWithoutId.observedAtMs,
    sensitivity: eventWithoutId.sensitivity,
    payload: eventWithoutId.payload,
  };
}
