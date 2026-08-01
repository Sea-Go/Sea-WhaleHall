import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import {
  DEFAULT_FLUSH_INTERVAL_MS,
  MAX_EVENT_LINE_BYTES,
  MAX_EVENTS_PER_SEGMENT,
  MAX_QUEUED_SEGMENTS,
  MAX_SEGMENT_BYTES,
  MAX_SPOOL_BYTES,
  MAX_SPOOL_SEGMENTS,
  SPOOL_DIRECTORY_NAME,
  type VscodeEditEventV1,
} from "./contracts.js";
import { validateBridgeDirectory } from "./path-policy.js";

const SEGMENT_NAME_PATTERN =
  /^segment-(\d{13})-([0-9a-f]{32})\.jsonl$/u;
const TEMP_NAME_PATTERN = /^\.tmp-[0-9a-f-]+$/u;
const ABANDONED_TEMPORARY_AGE_MS = 60 * 60 * 1_000;

export interface SpoolLimits {
  flushIntervalMs: number;
  maxEventLineBytes: number;
  maxEventsPerSegment: number;
  maxSegmentBytes: number;
  maxSpoolSegments: number;
  maxSpoolBytes: number;
  maxQueuedSegments: number;
}

export interface AtomicJsonlSpoolOptions {
  limits?: Partial<SpoolLimits>;
  onError?: (error: Error) => void;
}

export interface SpoolStatus {
  initialized: boolean;
  spoolDirectory: string | null;
  pendingEvents: number;
  pendingBytes: number;
  segmentCount: number;
  segmentBytes: number;
  lastError: string | null;
}

interface PendingLine {
  line: string;
  bytes: number;
  occurredAtMs: number;
}

interface PublishedSegment {
  name: string;
  bytes: number;
  modifiedAtMs: number;
}

const DEFAULT_LIMITS: Readonly<SpoolLimits> = Object.freeze({
  flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
  maxEventLineBytes: MAX_EVENT_LINE_BYTES,
  maxEventsPerSegment: MAX_EVENTS_PER_SEGMENT,
  maxSegmentBytes: MAX_SEGMENT_BYTES,
  maxSpoolSegments: MAX_SPOOL_SEGMENTS,
  maxSpoolBytes: MAX_SPOOL_BYTES,
  maxQueuedSegments: MAX_QUEUED_SEGMENTS,
});

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
}

function resolveLimits(overrides: Partial<SpoolLimits> = {}): SpoolLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [field, value] of Object.entries(limits)) {
    assertPositiveInteger(value, field);
  }
  if (limits.maxEventLineBytes > limits.maxSegmentBytes) {
    throw new Error("maxEventLineBytes must not exceed maxSegmentBytes");
  }
  return limits;
}

async function bestEffortChmod(target: string, mode: number): Promise<void> {
  try {
    await chmod(target, mode);
  } catch (error) {
    if (process.platform !== "win32") {
      throw error;
    }
  }
}

export class AtomicJsonlSpool {
  readonly #configuredRoot: string;
  readonly #limits: SpoolLimits;
  readonly #onError: ((error: Error) => void) | undefined;
  #spoolDirectory: string | null = null;
  #pending: PendingLine[] = [];
  #pendingBytes = 0;
  #timer: NodeJS.Timeout | null = null;
  #writeChain: Promise<void> = Promise.resolve();
  #initialization: Promise<void> | null = null;
  #closed = false;
  #lastError: string | null = null;
  #queuedSegments = 0;

  constructor(
    configuredRoot: string,
    options: AtomicJsonlSpoolOptions = {},
  ) {
    const validation = validateBridgeDirectory(configuredRoot);
    if (!validation.ok) {
      throw new Error(validation.reason);
    }
    this.#configuredRoot = validation.path;
    this.#limits = resolveLimits(options.limits);
    this.#onError = options.onError;
  }

  initialize(): Promise<void> {
    if (this.#initialization === null) {
      this.#initialization = this.#initializeOnce().catch((error: unknown) => {
        this.#initialization = null;
        throw error;
      });
    }
    return this.#initialization;
  }

  enqueue(event: VscodeEditEventV1): void {
    if (this.#closed) {
      throw new Error("spool is closed");
    }

    const line = `${JSON.stringify(event)}\n`;
    const bytes = Buffer.byteLength(line, "utf8");
    if (
      bytes > this.#limits.maxEventLineBytes ||
      bytes > this.#limits.maxSegmentBytes
    ) {
      throw new Error(
        `event ${event.eventId} exceeds the JSONL line or segment limit`,
      );
    }

    if (
      this.#pending.length > 0 &&
      (this.#pending.length >= this.#limits.maxEventsPerSegment ||
        this.#pendingBytes + bytes > this.#limits.maxSegmentBytes)
    ) {
      if (this.#queuedSegments >= this.#limits.maxQueuedSegments) {
        throw new Error("local spool writer is over its in-memory queue limit");
      }
      this.#flushInBackground();
    }

    if (
      this.#queuedSegments >= this.#limits.maxQueuedSegments &&
      (this.#pending.length + 1 >= this.#limits.maxEventsPerSegment ||
        this.#pendingBytes + bytes >= this.#limits.maxSegmentBytes)
    ) {
      throw new Error("local spool writer is over its in-memory queue limit");
    }

    this.#pending.push({ line, bytes, occurredAtMs: event.occurredAtMs });
    this.#pendingBytes += bytes;

    if (
      this.#pending.length >= this.#limits.maxEventsPerSegment ||
      this.#pendingBytes >= this.#limits.maxSegmentBytes
    ) {
      this.#flushInBackground();
      return;
    }
    this.#scheduleFlush();
  }

  flush(): Promise<void> {
    this.#clearTimer();
    const batch = this.#takePending();
    if (batch.length === 0) {
      return this.#writeChain;
    }
    if (this.#queuedSegments >= this.#limits.maxQueuedSegments) {
      this.#prependPending(batch);
      const error = new Error(
        "local spool writer is over its in-memory queue limit",
      );
      this.#lastError = error.message;
      this.#onError?.(error);
      return Promise.reject(error);
    }

    this.#queuedSegments += 1;
    const operation = this.#writeChain.then(async () => {
      await this.initialize();
      await this.#publish(batch);
      this.#lastError = null;
    });

    this.#writeChain = operation.then(
      () => {
        this.#queuedSegments -= 1;
      },
      (value: unknown) => {
        this.#queuedSegments -= 1;
        const error = asError(value);
        this.#lastError = error.message;
        this.#prependPending(batch);
        this.#onError?.(error);
        if (!this.#closed) {
          this.#scheduleFlush();
        }
      },
    );

    return operation;
  }

  async status(): Promise<SpoolStatus> {
    let segmentCount = 0;
    let segmentBytes = 0;
    if (this.#spoolDirectory !== null) {
      const segments = await this.#listPublishedSegments();
      segmentCount = segments.length;
      segmentBytes = segments.reduce((sum, entry) => sum + entry.bytes, 0);
    }

    return {
      initialized: this.#spoolDirectory !== null,
      spoolDirectory: this.#spoolDirectory,
      pendingEvents: this.#pending.length,
      pendingBytes: this.#pendingBytes,
      segmentCount,
      segmentBytes,
      lastError: this.#lastError,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) {
      await this.#writeChain;
      return;
    }
    this.#closed = true;
    this.#clearTimer();
    await this.#writeChain;
    await this.flush();
    await this.#writeChain;
  }

  async #initializeOnce(): Promise<void> {
    await mkdir(this.#configuredRoot, { mode: 0o700, recursive: true });
    const root = await realpath(this.#configuredRoot);
    const candidate = path.join(root, SPOOL_DIRECTORY_NAME);
    await mkdir(candidate, { mode: 0o700, recursive: true });

    const stat = await lstat(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("spool path must be a real directory, not a symlink");
    }
    const resolvedSpool = await realpath(candidate);
    const relative = path.relative(root, resolvedSpool);
    if (
      relative !== SPOOL_DIRECTORY_NAME ||
      path.isAbsolute(relative) ||
      relative.startsWith(`..${path.sep}`)
    ) {
      throw new Error("spool directory escaped the configured bridge root");
    }

    await bestEffortChmod(resolvedSpool, 0o700);
    this.#spoolDirectory = resolvedSpool;
    await this.#removeAbandonedTemporaryFiles();
    await this.#prune();
  }

  #takePending(): PendingLine[] {
    const batch = this.#pending;
    this.#pending = [];
    this.#pendingBytes = 0;
    return batch;
  }

  #prependPending(batch: PendingLine[]): void {
    this.#pending = [...batch, ...this.#pending];
    this.#pendingBytes = this.#pending.reduce(
      (sum, entry) => sum + entry.bytes,
      0,
    );
  }

  #scheduleFlush(): void {
    if (this.#timer !== null || this.#closed) {
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#flushInBackground();
    }, this.#limits.flushIntervalMs);
    this.#timer.unref();
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #flushInBackground(): void {
    void this.flush().catch(() => undefined);
  }

  async #assertSpoolDirectoryStillSafe(): Promise<string> {
    const spoolDirectory = this.#spoolDirectory;
    if (spoolDirectory === null) {
      throw new Error("spool has not been initialized");
    }
    const stat = await lstat(spoolDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("spool directory was replaced by an unsafe path");
    }
    if ((await realpath(spoolDirectory)) !== spoolDirectory) {
      throw new Error("spool directory target changed");
    }
    return spoolDirectory;
  }

  async #publish(batch: PendingLine[]): Promise<void> {
    if (batch.length === 0) {
      return;
    }
    const data = batch.map((entry) => entry.line).join("");
    const bytes = Buffer.byteLength(data, "utf8");
    if (
      batch.length > this.#limits.maxEventsPerSegment ||
      bytes > this.#limits.maxSegmentBytes
    ) {
      throw new Error("pending batch exceeds the configured segment limit");
    }

    const spoolDirectory = await this.#assertSpoolDirectoryStillSafe();
    const digest = createHash("sha256").update(data).digest("hex").slice(0, 32);
    const firstOccurredAtMs = Math.min(
      ...batch.map((entry) => entry.occurredAtMs),
    );
    const destinationName = `segment-${String(firstOccurredAtMs).padStart(13, "0")}-${digest}.jsonl`;
    const destination = path.join(spoolDirectory, destinationName);

    if (await this.#isIdenticalPublishedFile(destination, data, digest)) {
      await this.#prune();
      return;
    }

    const temporary = path.join(spoolDirectory, `.tmp-${randomUUID()}`);
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      const noFollow = fsConstants.O_NOFOLLOW ?? 0;
      handle = await open(
        temporary,
        fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_WRONLY |
          noFollow,
        0o600,
      );
      await handle.writeFile(data, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await bestEffortChmod(temporary, 0o600);
      await this.#assertSpoolDirectoryStillSafe();
      await rename(temporary, destination);
      await bestEffortChmod(destination, 0o600);
      await this.#syncDirectoryBestEffort(spoolDirectory);
    } finally {
      if (handle !== null) {
        await handle.close().catch(() => undefined);
      }
      await rm(temporary, { force: true }).catch(() => undefined);
    }

    await this.#prune();
  }

  async #isIdenticalPublishedFile(
    destination: string,
    data: string,
    digest: string,
  ): Promise<boolean> {
    try {
      const stat = await lstat(destination);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("a non-regular file blocks a spool segment");
      }
      if (stat.size > this.#limits.maxSegmentBytes) {
        throw new Error("an oversized file blocks a spool segment");
      }
      const existing = await readFile(destination);
      const existingDigest = createHash("sha256")
        .update(existing)
        .digest("hex")
        .slice(0, 32);
      if (
        existingDigest !== digest ||
        existing.length !== Buffer.byteLength(data, "utf8")
      ) {
        throw new Error("spool segment hash collision or tampering detected");
      }
      return true;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return false;
      }
      throw error;
    }
  }

  async #syncDirectoryBestEffort(directory: string): Promise<void> {
    try {
      const handle = await open(directory, fsConstants.O_RDONLY);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // Windows and some filesystems do not allow syncing a directory handle.
    }
  }

  async #removeAbandonedTemporaryFiles(): Promise<void> {
    const spoolDirectory = await this.#assertSpoolDirectoryStillSafe();
    const entries = await readdir(spoolDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (
        TEMP_NAME_PATTERN.test(entry.name) &&
        (entry.isFile() || entry.isSymbolicLink())
      ) {
        const temporaryPath = path.join(spoolDirectory, entry.name);
        const stat = await lstat(temporaryPath);
        if (Date.now() - stat.mtimeMs >= ABANDONED_TEMPORARY_AGE_MS) {
          await rm(temporaryPath, { force: true });
        }
      }
    }
  }

  async #listPublishedSegments(): Promise<PublishedSegment[]> {
    const spoolDirectory = await this.#assertSpoolDirectoryStillSafe();
    const entries = await readdir(spoolDirectory, { withFileTypes: true });
    const segments: PublishedSegment[] = [];

    for (const entry of entries) {
      if (!SEGMENT_NAME_PATTERN.test(entry.name) || !entry.isFile()) {
        continue;
      }
      const entryPath = path.join(spoolDirectory, entry.name);
      const stat = await lstat(entryPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        continue;
      }
      segments.push({
        name: entry.name,
        bytes: stat.size,
        modifiedAtMs: stat.mtimeMs,
      });
    }
    return segments;
  }

  async #prune(): Promise<void> {
    const spoolDirectory = await this.#assertSpoolDirectoryStillSafe();
    const segments = await this.#listPublishedSegments();
    segments.sort(
      (left, right) =>
        left.modifiedAtMs - right.modifiedAtMs ||
        left.name.localeCompare(right.name),
    );

    let count = segments.length;
    let bytes = segments.reduce((sum, entry) => sum + entry.bytes, 0);
    for (const segment of segments) {
      if (
        count <= this.#limits.maxSpoolSegments &&
        bytes <= this.#limits.maxSpoolBytes
      ) {
        break;
      }
      await rm(path.join(spoolDirectory, segment.name), { force: true });
      count -= 1;
      bytes -= segment.bytes;
    }
  }
}
