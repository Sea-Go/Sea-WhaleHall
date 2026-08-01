export const EDIT_EVENT_SCHEMA_VERSION = "whalehall-vscode-edit.v1" as const;
export const EDIT_EVENT_KIND = "editor.documentChanged" as const;
export const EDIT_EVENT_SOURCE = "vscode.extension" as const;
export const SPOOL_PROTOCOL_VERSION = "whalehall.vscode-spool.v1" as const;
export const SPOOL_DIRECTORY_NAME = ".whalehall-vscode-spool-v1" as const;

export const MAX_CHANGES_PER_EVENT = 128;
export const MAX_INSERTED_TEXT_CODEPOINTS_PER_CHANGE = 1_024;
export const MAX_INSERTED_TEXT_BYTES_PER_EVENT = 16 * 1_024;
export const MAX_INSERTED_TEXT_JSON_BYTES_PER_EVENT = 32 * 1_024;
export const MAX_EVENT_LINE_BYTES = 64 * 1_024;
export const MAX_EVENTS_PER_SEGMENT = 128;
export const MAX_SEGMENT_BYTES = 256 * 1_024;
export const MAX_SPOOL_SEGMENTS = 4_096;
export const MAX_SPOOL_BYTES = 64 * 1_024 * 1_024;
export const MAX_QUEUED_SEGMENTS = 8;
export const DEFAULT_FLUSH_INTERVAL_MS = 500;

export type EditEventSensitivity = "metadata" | "content";

export interface SafeEditDeltaV1 {
  rangeOffset: number;
  deletedChars: number;
  insertedChars: number;
  insertedText?: string;
  insertedTextTruncated?: boolean;
}

export interface VscodeEditEventV1 {
  schemaVersion: typeof EDIT_EVENT_SCHEMA_VERSION;
  eventId: string;
  kind: typeof EDIT_EVENT_KIND;
  source: typeof EDIT_EVENT_SOURCE;
  occurredAtMs: number;
  observedAtMs: number;
  sensitivity: EditEventSensitivity;
  payload: {
    workspaceId: string;
    document: {
      relativePath: string;
      languageId: string;
      version: number;
    };
    changeCount: number;
    emittedChangeCount: number;
    changesTruncated: boolean;
    changes: SafeEditDeltaV1[];
  };
}

export interface RawDocumentChange {
  rangeOffset: number;
  rangeLength: number;
  text: string;
}

export interface BuildEditEventInput {
  sourceInstanceId: string;
  workspaceUri: string;
  relativePath: string;
  languageId: string;
  documentVersion: number;
  occurredAtMs: number;
  observedAtMs: number;
  includeText: boolean;
  contentChanges: readonly RawDocumentChange[];
}
