import { createHash, webcrypto } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import type { AgentRunStatus as SharedAgentRunStatus } from "../shared/agent-runs";
import {
	AGENT_READ_PERMISSION_IDS,
	type AgentReadPermissionsSnapshot,
} from "../shared/agent-permissions";
import type { CalendarEvent } from "../shared/calendar";
import type { PlanningAuthoritySnapshot } from "../shared/planning-authority";
import type {
	AgentPermission,
	PendingToolApproval,
	ToolApprovalRepository,
} from "./agent-tool-policy";
import {
	CredentialHelperError,
	type CredentialKeyReference,
	type CredentialKeyStore,
} from "./credential-helper-client";
import {
	planningCommitCoordinationDigest,
	planningDraftDigest,
} from "./planning-authority-digest";

const DATABASE_SCHEMA_VERSION = 1;
const CIPHER_VERSION = 1;
const KEY_VERSION = 1;
const NONCE_BYTES = 12;
const MAX_LIST_LIMIT = 1_000;

export interface AgentConversationRecord {
	accountId: string;
	id: string;
	title: string;
	createdAtMs: number;
	updatedAtMs: number;
}

export type AgentMessageRole = "system" | "user" | "assistant" | "tool";

export type AgentMessageStatus =
	| "complete"
	| "partial"
	| "cancelled"
	| "failed"
	| "interrupted";

export interface AgentMessageRecord {
	accountId: string;
	id: string;
	conversationId: string;
	clientMessageId: string | null;
	runId: string | null;
	role: AgentMessageRole;
	status: AgentMessageStatus;
	content: string;
	createdAtMs: number;
}

export interface AgentWorkflowRecord {
	accountId: string;
	id: string;
	name: string;
	definition: unknown;
	enabled: boolean;
	createdAtMs: number;
	updatedAtMs: number;
}

export interface AgentWorkflowSnapshotRecord {
	accountId: string;
	workflowName: string;
	runId: string;
	resourceId: string;
	snapshot: unknown;
	createdAtMs: number;
	updatedAtMs: number;
}

export interface AgentWorkflowSnapshotListOptions {
	workflowName?: string;
	fromDateMs?: number;
	toDateMs?: number;
	perPage?: number | false;
	page?: number;
	resourceId?: string;
	status?: string;
}

export interface AgentWorkflowSnapshotListResult {
	runs: AgentWorkflowSnapshotRecord[];
	total: number;
}

export type AgentRunStatus = SharedAgentRunStatus;

export interface AgentRunRecord {
	accountId: string;
	id: string;
	conversationId: string | null;
	workflowId: string | null;
	status: AgentRunStatus;
	input: unknown;
	output: unknown | null;
	error: unknown | null;
	createdAtMs: number;
	updatedAtMs: number;
	completedAtMs: number | null;
}

export interface AgentCalendarEventRecord {
	accountId: string;
	event: CalendarEvent;
	updatedAtMs: number;
}

export interface CalendarBatchCommit {
	expectedRevision: number;
	upserts: readonly AgentCalendarEventRecord[];
	deletes: readonly string[];
}

export interface PlanningCalendarAuthorityCommit {
	commitId: string;
	expectedAuthorityRevision: number;
	calendar: CalendarBatchCommit;
	authority: PlanningAuthoritySnapshot;
	/** Synchronous exact-session guard executed after encryption, under the IMMEDIATE lock. */
	beforeCommit?: () => void;
}

export interface PlanningCalendarAuthorityCommitResult {
	calendarRevision: number;
	authorityRevision: number;
	idempotent: boolean;
}

export interface CalendarEventListOptions {
	from?: string;
	to?: string;
	limit?: number;
	offset?: number;
}

export interface EncryptedAgentRepositoryOptions {
	databasePath: string;
	installationId: string;
	keyStore: CredentialKeyStore;
	now?: () => number;
}

export type EncryptedAgentRepositoryErrorCode =
	| "INVALID_ARGUMENT"
	| "ACCOUNT_KEY_MISSING"
	| "ACCOUNT_DELETING"
	| "DECRYPTION_FAILED"
	| "SERIALIZATION_FAILED"
	| "SCHEMA_UNSUPPORTED";

export class EncryptedAgentRepositoryError extends Error {
	constructor(
		public readonly code: EncryptedAgentRepositoryErrorCode,
		message: string,
	) {
		super(message);
		this.name = "EncryptedAgentRepositoryError";
	}
}

export class CalendarRevisionConflictError extends Error {
	constructor(
		public readonly expectedRevision: number,
		public readonly actualRevision: number,
	) {
		super(
			`Calendar revision changed concurrently (expected ${expectedRevision}, actual ${actualRevision}).`,
		);
		this.name = "CalendarRevisionConflictError";
	}
}

export class AgentPermissionRevisionConflictError extends Error {
	constructor(
		public readonly expectedRevision: number,
		public readonly actualRevision: number,
	) {
		super(
			`Agent permission revision changed concurrently (expected ${expectedRevision}, actual ${actualRevision}).`,
		);
		this.name = "AgentPermissionRevisionConflictError";
	}
}

export class PlanningAuthorityRevisionConflictError extends Error {
	constructor(
		public readonly expectedRevision: number,
		public readonly actualRevision: number,
	) {
		super(
			`Planning authority revision changed concurrently (expected ${expectedRevision}, actual ${actualRevision}).`,
		);
		this.name = "PlanningAuthorityRevisionConflictError";
	}
}

type AccountRow = {
	key_id: string;
	key_version: number;
	state: "active" | "deleting";
};

type CipherRow = {
	key_version: number;
	cipher_version: number;
	nonce: Uint8Array;
	ciphertext: Uint8Array;
};

type AccountContext = {
	keyReference: CredentialKeyReference;
	cryptoKey: webcrypto.CryptoKey;
};

type PreparedCipher = {
	keyVersion: number;
	cipherVersion: number;
	nonce: Uint8Array;
	ciphertext: Uint8Array;
};

type PreparedCalendarEvent = {
	record: AgentCalendarEventRecord;
	cipher: PreparedCipher;
	startDate: string;
	endDateExclusive: string;
};

type ConversationRow = CipherRow & {
	conversation_id: string;
	created_at_ms: number;
	updated_at_ms: number;
};

type MessageRow = CipherRow & {
	message_id: string;
	conversation_id: string;
	client_message_id: string | null;
	run_id: string | null;
	role: AgentMessageRole;
	status: AgentMessageStatus;
	created_at_ms: number;
};

type WorkflowRow = {
	workflow_id: string;
	name_key_version: number;
	name_cipher_version: number;
	name_nonce: Uint8Array;
	name_ciphertext: Uint8Array;
	definition_key_version: number;
	definition_cipher_version: number;
	definition_nonce: Uint8Array;
	definition_ciphertext: Uint8Array;
	enabled: number;
	created_at_ms: number;
	updated_at_ms: number;
};

type WorkflowSnapshotRow = CipherRow & {
	workflow_name: string;
	run_id: string;
	created_at_ms: number;
	updated_at_ms: number;
};

type RunRow = {
	run_id: string;
	conversation_id: string | null;
	workflow_id: string | null;
	status: AgentRunStatus;
	input_key_version: number;
	input_cipher_version: number;
	input_nonce: Uint8Array;
	input_ciphertext: Uint8Array;
	output_key_version: number | null;
	output_cipher_version: number | null;
	output_nonce: Uint8Array | null;
	output_ciphertext: Uint8Array | null;
	error_key_version: number | null;
	error_cipher_version: number | null;
	error_nonce: Uint8Array | null;
	error_ciphertext: Uint8Array | null;
	created_at_ms: number;
	updated_at_ms: number;
	completed_at_ms: number | null;
};

type CalendarEventRow = CipherRow & {
	event_id: string;
	start_date: string;
	end_date_exclusive: string;
	updated_at_ms: number;
};

type PlanningAuthorityRow = CipherRow & {
	revision: number;
	status: PlanningAuthoritySnapshot["status"];
	last_commit_id: string | null;
	last_commit_digest: string | null;
	commit_calendar_revision: number | null;
	updated_at_ms: number;
};

type ApprovalRow = {
	approval_id: string;
	run_id: string;
	tool_call_id: string;
	tool_name: PendingToolApproval["toolName"];
	arguments_digest: string;
	run_revision: number;
	arguments_key_version: number;
	arguments_cipher_version: number;
	arguments_nonce: Uint8Array;
	arguments_ciphertext: Uint8Array;
	created_at_ms: number;
	expires_at_ms: number;
	status: PendingToolApproval["status"];
};

/**
 * Bun-owned, account-partitioned encrypted persistence for Agent data.
 *
 * The SQLite file contains only authenticated ciphertext for user-authored
 * content. A distinct 256-bit key per account lives in the OS credential store.
 * Refresh tokens intentionally do not use this repository; they are stored
 * directly through CredentialHelperClient's fixed named-secret API.
 */
export class EncryptedAgentRepository implements ToolApprovalRepository {
	private readonly database: Database;
	private readonly installationId: string;
	private readonly keyStore: CredentialKeyStore;
	private readonly now: () => number;
	private readonly accountContexts = new Map<string, AccountContext>();
	private readonly accountLoads = new Map<string, Promise<AccountContext>>();
	private closed = false;

	constructor(options: EncryptedAgentRepositoryOptions) {
		validateStorageComponent(options.installationId, "installationId");
		this.installationId = options.installationId;
		this.keyStore = options.keyStore;
		this.now = options.now ?? Date.now;

		const directory = dirname(options.databasePath);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		hardenPath(directory, 0o700);
		this.database = new Database(options.databasePath, {
			create: true,
			strict: true,
		});
		this.configure();
		this.migrate();
		hardenPath(options.databasePath, 0o600);
		hardenPath(`${options.databasePath}-wal`, 0o600);
		hardenPath(`${options.databasePath}-shm`, 0o600);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.accountContexts.clear();
		this.accountLoads.clear();
		this.database.close();
	}

	async ensureAccount(accountId: string): Promise<void> {
		await this.accountContext(accountId);
	}

	async forgetAccount(accountId: string): Promise<{ deleted: boolean }> {
		this.requireOpen();
		validateIdentifier(accountId, "accountId");
		const row = this.accountRow(accountId);
		if (!row) return { deleted: false };
		const markDeleting = this.database.transaction(() => {
			this.database
				.query(
					"UPDATE encrypted_accounts SET state = 'deleting', updated_at_ms = ? WHERE account_id = ?",
				)
				.run(this.now(), accountId);
		});
		markDeleting.immediate();
		this.accountContexts.delete(accountId);
		this.accountLoads.delete(accountId);
		await this.keyStore.deleteKey({
			installationId: this.installationId,
			accountId: row.key_id,
			keyVersion: row.key_version,
		});
		const erase = this.database.transaction(() => {
			this.database
				.query("DELETE FROM encrypted_accounts WHERE account_id = ?")
				.run(accountId);
		});
		erase.immediate();
		return { deleted: true };
	}

	async hasGrant(
		accountId: string,
		permission: AgentPermission,
	): Promise<boolean> {
		this.requireOpen();
		validateIdentifier(accountId, "accountId");
		validatePermission(permission);
		return (
			this.database
				.query(
					"SELECT 1 AS present FROM agent_tool_grants WHERE account_id = ? AND permission = ?",
				)
				.get(accountId, permission) !== null
		);
	}

	async getAgentReadPermissions(
		accountId: string,
	): Promise<AgentReadPermissionsSnapshot> {
		this.requireOpen();
		validateIdentifier(accountId, "accountId");
		await this.accountContext(accountId);
		const grants = this.database
			.query(
				`SELECT permission FROM agent_tool_grants
				 WHERE account_id = ?
				 ORDER BY permission`,
			)
			.all(accountId) as Array<{ permission: AgentPermission }>;
		const revision = this.database
			.query(
				`SELECT revision, updated_at_ms
				 FROM agent_permission_revisions WHERE account_id = ?`,
			)
			.get(accountId) as { revision: number; updated_at_ms: number } | null;
		return {
			grants: grants.map((row) => row.permission),
			revision: revision?.revision ?? 0,
			updatedAtMs: revision?.updated_at_ms ?? null,
		};
	}

	async setAgentReadPermissions(
		accountId: string,
		enabled: boolean,
		expectedRevision: number,
	): Promise<AgentReadPermissionsSnapshot> {
		this.requireOpen();
		validateIdentifier(accountId, "accountId");
		if (typeof enabled !== "boolean") {
			throw invalidArgument("Agent read permission state is invalid.");
		}
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
			throw invalidArgument("Agent permission revision is invalid.");
		}
		await this.accountContext(accountId);
		const updatedAtMs = this.now();
		let nextRevision = expectedRevision + 1;
		const mutate = this.database.transaction(() => {
			const row = this.database
				.query(
					"SELECT revision FROM agent_permission_revisions WHERE account_id = ?",
				)
				.get(accountId) as { revision: number } | null;
			const actualRevision = row?.revision ?? 0;
			if (actualRevision !== expectedRevision) {
				throw new AgentPermissionRevisionConflictError(
					expectedRevision,
					actualRevision,
				);
			}
			nextRevision = actualRevision + 1;
			this.database
				.query("DELETE FROM agent_tool_grants WHERE account_id = ?")
				.run(accountId);
			if (enabled) {
				const insert = this.database.query(
					`INSERT INTO agent_tool_grants (account_id, permission, updated_at_ms)
					 VALUES (?, ?, ?)`,
				);
				for (const permission of AGENT_READ_PERMISSION_IDS) {
					insert.run(accountId, permission, updatedAtMs);
				}
			}
			this.database
				.query(
					`INSERT INTO agent_permission_revisions
					 (account_id, revision, updated_at_ms) VALUES (?, ?, ?)
					 ON CONFLICT(account_id) DO UPDATE SET
					  revision = excluded.revision,
					  updated_at_ms = excluded.updated_at_ms`,
				)
				.run(accountId, nextRevision, updatedAtMs);
		});
		mutate.immediate();
		return {
			grants: enabled ? [...AGENT_READ_PERMISSION_IDS] : [],
			revision: nextRevision,
			updatedAtMs,
		};
	}

	async setGrant(
		accountId: string,
		permission: AgentPermission,
		granted = true,
	): Promise<void> {
		this.requireOpen();
		validateIdentifier(accountId, "accountId");
		validatePermission(permission);
		if (typeof granted !== "boolean") {
			throw invalidArgument("Grant state is invalid.");
		}
		await this.accountContext(accountId);
		const updatedAtMs = this.now();
		const mutate = this.database.transaction(() => {
			if (!granted) {
				this.database
					.query(
						"DELETE FROM agent_tool_grants WHERE account_id = ? AND permission = ?",
					)
					.run(accountId, permission);
			} else {
				this.database
					.query(
						`INSERT INTO agent_tool_grants (account_id, permission, updated_at_ms)
						 VALUES (?, ?, ?)
						 ON CONFLICT(account_id, permission) DO UPDATE SET
						  updated_at_ms = excluded.updated_at_ms`,
					)
					.run(accountId, permission, updatedAtMs);
			}
			this.database
				.query(
					`INSERT INTO agent_permission_revisions
					 (account_id, revision, updated_at_ms) VALUES (?, 1, ?)
					 ON CONFLICT(account_id) DO UPDATE SET
					  revision = agent_permission_revisions.revision + 1,
					  updated_at_ms = excluded.updated_at_ms`,
				)
				.run(accountId, updatedAtMs);
		});
		mutate.immediate();
	}

	async putApproval(approval: PendingToolApproval): Promise<void> {
		validateApproval(approval);
		if (approval.status !== "pending") {
			throw invalidArgument("A new approval must be pending.");
		}
		const encryptedArguments = await this.encryptJson(
			approval.accountId,
			"tool_approvals",
			approval.approvalId,
			"arguments",
			approval.arguments,
		);
		this.database
			.query(
				`INSERT INTO tool_approvals
				 (account_id, approval_id, run_id, tool_call_id, tool_name,
				  arguments_digest, run_revision,
				  arguments_key_version, arguments_cipher_version,
				  arguments_nonce, arguments_ciphertext,
				  created_at_ms, expires_at_ms, status)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				approval.accountId,
				approval.approvalId,
				approval.runId,
				approval.toolCallId,
				approval.toolName,
				approval.argumentsDigest,
				approval.runRevision,
				encryptedArguments.keyVersion,
				encryptedArguments.cipherVersion,
				encryptedArguments.nonce,
				encryptedArguments.ciphertext,
				approval.createdAtMs,
				approval.expiresAtMs,
				approval.status,
			);
	}

	async getApproval(
		accountId: string,
		approvalId: string,
	): Promise<PendingToolApproval | null> {
		this.requireOpen();
		validateIdentifier(accountId, "accountId");
		validateIdentifier(approvalId, "approvalId");
		const row = this.database
			.query(
				"SELECT * FROM tool_approvals WHERE account_id = ? AND approval_id = ?",
			)
			.get(accountId, approvalId) as ApprovalRow | null;
		if (!row) return null;
		const argumentsValue = await this.decryptJson(
			accountId,
			"tool_approvals",
			row.approval_id,
			"arguments",
			{
				key_version: row.arguments_key_version,
				cipher_version: row.arguments_cipher_version,
				nonce: row.arguments_nonce,
				ciphertext: row.arguments_ciphertext,
			},
		);
		if (!isRecord(argumentsValue)) throw decryptionFailure();
		return {
			approvalId: row.approval_id,
			accountId,
			runId: row.run_id,
			toolCallId: row.tool_call_id,
			toolName: row.tool_name,
			argumentsDigest: row.arguments_digest,
			runRevision: row.run_revision,
			arguments: argumentsValue,
			createdAtMs: row.created_at_ms,
			expiresAtMs: row.expires_at_ms,
			status: row.status,
		};
	}

	async compareAndSetApprovalStatus(
		accountId: string,
		approvalId: string,
		expected: PendingToolApproval["status"],
		next: PendingToolApproval["status"],
	): Promise<boolean> {
		this.requireOpen();
		validateIdentifier(accountId, "accountId");
		validateIdentifier(approvalId, "approvalId");
		validateApprovalStatus(expected);
		validateApprovalStatus(next);
		if (expected !== "pending" || next === "pending") {
			throw invalidArgument("Approval status changes must consume a pending approval.");
		}
		const result = this.database
			.query(
				`UPDATE tool_approvals SET status = ?
				 WHERE account_id = ? AND approval_id = ? AND status = ?`,
			)
			.run(next, accountId, approvalId, expected);
		return result.changes === 1;
	}

	async putConversation(
		record: AgentConversationRecord,
	): Promise<AgentConversationRecord> {
		validateConversation(record);
		const title = await this.encryptText(
			record.accountId,
			"conversations",
			record.id,
			"title",
			record.title,
		);
		this.database
			.query(
				`INSERT INTO conversations
				 (account_id, conversation_id, key_version, cipher_version, title_nonce,
				  title_ciphertext, created_at_ms, updated_at_ms)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(account_id, conversation_id) DO UPDATE SET
				  key_version = excluded.key_version,
				  cipher_version = excluded.cipher_version,
				  title_nonce = excluded.title_nonce,
				  title_ciphertext = excluded.title_ciphertext,
				  created_at_ms = excluded.created_at_ms,
				  updated_at_ms = excluded.updated_at_ms`,
			)
			.run(
				record.accountId,
				record.id,
				title.keyVersion,
				title.cipherVersion,
				title.nonce,
				title.ciphertext,
				record.createdAtMs,
				record.updatedAtMs,
			);
		return { ...record };
	}

	async getConversation(
		accountId: string,
		conversationId: string,
	): Promise<AgentConversationRecord | null> {
		validateIdentifier(accountId, "accountId");
		validateIdentifier(conversationId, "conversationId");
		const row = this.database
			.query(
				`SELECT conversation_id, key_version, cipher_version,
				        title_nonce AS nonce, title_ciphertext AS ciphertext,
				        created_at_ms, updated_at_ms
				 FROM conversations WHERE account_id = ? AND conversation_id = ?`,
			)
			.get(accountId, conversationId) as ConversationRow | null;
		return row ? this.conversationFromRow(accountId, row) : null;
	}

	async listConversations(
		accountId: string,
		limit = 100,
	): Promise<AgentConversationRecord[]> {
		validateIdentifier(accountId, "accountId");
		validateLimit(limit);
		const rows = this.database
			.query(
				`SELECT conversation_id, key_version, cipher_version,
				        title_nonce AS nonce, title_ciphertext AS ciphertext,
				        created_at_ms, updated_at_ms
				 FROM conversations WHERE account_id = ?
				 ORDER BY updated_at_ms DESC, conversation_id DESC LIMIT ?`,
			)
			.all(accountId, limit) as ConversationRow[];
		return Promise.all(rows.map((row) => this.conversationFromRow(accountId, row)));
	}

	async putMessage(record: AgentMessageRecord): Promise<AgentMessageRecord> {
		validateMessage(record);
		const content = await this.encryptText(
			record.accountId,
			"messages",
			record.id,
			"content",
			record.content,
		);
		this.database
			.query(
				`INSERT INTO messages
				 (account_id, message_id, conversation_id, client_message_id, run_id,
				  role, status, key_version,
				  cipher_version, content_nonce, content_ciphertext, created_at_ms)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(account_id, message_id) DO UPDATE SET
				  conversation_id = excluded.conversation_id,
				  client_message_id = excluded.client_message_id,
				  run_id = excluded.run_id,
				  role = excluded.role,
				  status = excluded.status,
				  key_version = excluded.key_version,
				  cipher_version = excluded.cipher_version,
				  content_nonce = excluded.content_nonce,
				  content_ciphertext = excluded.content_ciphertext,
				  created_at_ms = excluded.created_at_ms`,
			)
			.run(
				record.accountId,
				record.id,
				record.conversationId,
				record.clientMessageId,
				record.runId,
				record.role,
				record.status,
				content.keyVersion,
				content.cipherVersion,
				content.nonce,
				content.ciphertext,
				record.createdAtMs,
			);
		return { ...record };
	}

	async getMessage(
		accountId: string,
		messageId: string,
	): Promise<AgentMessageRecord | null> {
		validateIdentifier(accountId, "accountId");
		validateIdentifier(messageId, "messageId");
		const row = this.database
			.query(
				`SELECT message_id, conversation_id, client_message_id, run_id,
				        role, status, key_version, cipher_version,
				        content_nonce AS nonce, content_ciphertext AS ciphertext, created_at_ms
				 FROM messages WHERE account_id = ? AND message_id = ?`,
			)
			.get(accountId, messageId) as MessageRow | null;
		return row ? this.messageFromRow(accountId, row) : null;
	}

	async getMessageByClientMessageId(
		accountId: string,
		clientMessageId: string,
	): Promise<AgentMessageRecord | null> {
		validateIdentifier(accountId, "accountId");
		validateIdentifier(clientMessageId, "clientMessageId");
		const row = this.database
			.query(
				`SELECT message_id, conversation_id, client_message_id, run_id,
				        role, status, key_version, cipher_version,
				        content_nonce AS nonce, content_ciphertext AS ciphertext, created_at_ms
				 FROM messages WHERE account_id = ? AND client_message_id = ?`,
			)
			.get(accountId, clientMessageId) as MessageRow | null;
		return row ? this.messageFromRow(accountId, row) : null;
	}

	async listMessages(
		accountId: string,
		conversationId: string,
		limit = 500,
	): Promise<AgentMessageRecord[]> {
		validateIdentifier(accountId, "accountId");
		validateIdentifier(conversationId, "conversationId");
		validateLimit(limit);
		const rows = this.database
			.query(
				`SELECT message_id, conversation_id, client_message_id, run_id,
				        role, status, key_version, cipher_version,
				        content_nonce AS nonce, content_ciphertext AS ciphertext, created_at_ms
				 FROM messages WHERE account_id = ? AND conversation_id = ?
				 ORDER BY created_at_ms ASC, message_id ASC LIMIT ?`,
			)
			.all(accountId, conversationId, limit) as MessageRow[];
		return Promise.all(rows.map((row) => this.messageFromRow(accountId, row)));
	}

	/** Complete messages only; safe as the source for subsequent model context. */
	async listContextMessages(
		accountId: string,
		conversationId: string,
		limit = 500,
	): Promise<AgentMessageRecord[]> {
		validateIdentifier(accountId, "accountId");
		validateIdentifier(conversationId, "conversationId");
		validateLimit(limit);
		const rows = this.database
			.query(
				`SELECT message_id, conversation_id, client_message_id, run_id,
				        role, status, key_version, cipher_version,
				        content_nonce AS nonce, content_ciphertext AS ciphertext, created_at_ms
				 FROM messages
				 WHERE account_id = ? AND conversation_id = ? AND status = 'complete'
				 ORDER BY created_at_ms ASC, message_id ASC LIMIT ?`,
			)
			.all(accountId, conversationId, limit) as MessageRow[];
		return Promise.all(rows.map((row) => this.messageFromRow(accountId, row)));
	}

	async putWorkflow(record: AgentWorkflowRecord): Promise<AgentWorkflowRecord> {
		validateWorkflow(record);
		const [name, definition] = await Promise.all([
			this.encryptText(record.accountId, "workflows", record.id, "name", record.name),
			this.encryptJson(
				record.accountId,
				"workflows",
				record.id,
				"definition",
				record.definition,
			),
		]);
		this.database
			.query(
				`INSERT INTO workflows
				 (account_id, workflow_id,
				  name_key_version, name_cipher_version, name_nonce, name_ciphertext,
				  definition_key_version, definition_cipher_version,
				  definition_nonce, definition_ciphertext,
				  enabled, created_at_ms, updated_at_ms)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(account_id, workflow_id) DO UPDATE SET
				  name_key_version = excluded.name_key_version,
				  name_cipher_version = excluded.name_cipher_version,
				  name_nonce = excluded.name_nonce,
				  name_ciphertext = excluded.name_ciphertext,
				  definition_key_version = excluded.definition_key_version,
				  definition_cipher_version = excluded.definition_cipher_version,
				  definition_nonce = excluded.definition_nonce,
				  definition_ciphertext = excluded.definition_ciphertext,
				  enabled = excluded.enabled,
				  created_at_ms = excluded.created_at_ms,
				  updated_at_ms = excluded.updated_at_ms`,
			)
			.run(
				record.accountId,
				record.id,
				name.keyVersion,
				name.cipherVersion,
				name.nonce,
				name.ciphertext,
				definition.keyVersion,
				definition.cipherVersion,
				definition.nonce,
				definition.ciphertext,
				record.enabled ? 1 : 0,
				record.createdAtMs,
				record.updatedAtMs,
			);
		return structuredClone(record);
	}

	/**
	 * Creates a workflow when expectedVersion is null, or updates it only when
	 * its current updated_at_ms exactly matches expectedVersion. The timestamp is
	 * the workflow's opaque optimistic version; callers must advance it on every
	 * successful update.
	 */
	async compareAndSetWorkflow(
		record: AgentWorkflowRecord,
		expectedVersion: number | null,
	): Promise<boolean> {
		validateWorkflow(record);
		if (expectedVersion !== null) validateTimestamp(expectedVersion, "expectedVersion");
		const [name, definition] = await Promise.all([
			this.encryptText(record.accountId, "workflows", record.id, "name", record.name),
			this.encryptJson(
				record.accountId,
				"workflows",
				record.id,
				"definition",
				record.definition,
			),
		]);
		if (expectedVersion === null) {
			const result = this.database
				.query(
					`INSERT INTO workflows
					 (account_id, workflow_id,
					  name_key_version, name_cipher_version, name_nonce, name_ciphertext,
					  definition_key_version, definition_cipher_version, definition_nonce, definition_ciphertext,
					  enabled, created_at_ms, updated_at_ms)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(account_id, workflow_id) DO NOTHING`,
				)
				.run(
					record.accountId,
					record.id,
					name.keyVersion,
					name.cipherVersion,
					name.nonce,
					name.ciphertext,
					definition.keyVersion,
					definition.cipherVersion,
					definition.nonce,
					definition.ciphertext,
					record.enabled ? 1 : 0,
					record.createdAtMs,
					record.updatedAtMs,
				);
			return result.changes === 1;
		}

		const result = this.database
			.query(
				`UPDATE workflows SET
				 name_key_version = ?, name_cipher_version = ?, name_nonce = ?, name_ciphertext = ?,
				 definition_key_version = ?, definition_cipher_version = ?, definition_nonce = ?, definition_ciphertext = ?,
				 enabled = ?, updated_at_ms = ?
				 WHERE account_id = ? AND workflow_id = ? AND updated_at_ms = ?`,
			)
			.run(
				name.keyVersion,
				name.cipherVersion,
				name.nonce,
				name.ciphertext,
				definition.keyVersion,
				definition.cipherVersion,
				definition.nonce,
				definition.ciphertext,
				record.enabled ? 1 : 0,
				record.updatedAtMs,
				record.accountId,
				record.id,
				expectedVersion,
			);
		return result.changes === 1;
	}

	async getWorkflow(
		accountId: string,
		workflowId: string,
	): Promise<AgentWorkflowRecord | null> {
		validateIdentifier(accountId, "accountId");
		validateIdentifier(workflowId, "workflowId");
		const row = this.database
			.query("SELECT * FROM workflows WHERE account_id = ? AND workflow_id = ?")
			.get(accountId, workflowId) as WorkflowRow | null;
		return row ? this.workflowFromRow(accountId, row) : null;
	}

	async listWorkflows(
		accountId: string,
		limit = 100,
	): Promise<AgentWorkflowRecord[]> {
		validateIdentifier(accountId, "accountId");
		validateLimit(limit);
		const rows = this.database
			.query(
				`SELECT * FROM workflows WHERE account_id = ?
				 ORDER BY updated_at_ms DESC, workflow_id DESC LIMIT ?`,
			)
			.all(accountId, limit) as WorkflowRow[];
		return Promise.all(rows.map((row) => this.workflowFromRow(accountId, row)));
	}

	async putWorkflowSnapshot(
		record: AgentWorkflowSnapshotRecord,
	): Promise<AgentWorkflowSnapshotRecord> {
		validateWorkflowSnapshot(record);
		if (record.resourceId !== record.accountId) {
			throw invalidArgument("Workflow snapshot resource must match its account.");
		}
		const rowId = workflowSnapshotRowId(record.workflowName, record.runId);
		const snapshot = await this.encryptJson(
			record.accountId,
			"mastra_workflow_snapshots",
			rowId,
			"snapshot",
			record.snapshot,
		);
		this.database
			.query(
				`INSERT INTO mastra_workflow_snapshots
				 (account_id, workflow_name, run_id,
				  key_version, cipher_version, snapshot_nonce, snapshot_ciphertext,
				  created_at_ms, updated_at_ms)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(account_id, workflow_name, run_id) DO UPDATE SET
				  key_version = excluded.key_version,
				  cipher_version = excluded.cipher_version,
				  snapshot_nonce = excluded.snapshot_nonce,
				  snapshot_ciphertext = excluded.snapshot_ciphertext,
				  created_at_ms = mastra_workflow_snapshots.created_at_ms,
				  updated_at_ms = excluded.updated_at_ms`,
			)
			.run(
				record.accountId,
				record.workflowName,
				record.runId,
				snapshot.keyVersion,
				snapshot.cipherVersion,
				snapshot.nonce,
				snapshot.ciphertext,
				record.createdAtMs,
				record.updatedAtMs,
			);
		return structuredClone(record);
	}

	async getWorkflowSnapshot(
		accountId: string,
		runId: string,
		workflowName?: string,
	): Promise<AgentWorkflowSnapshotRecord | null> {
		validateIdentifier(accountId, "accountId");
		validateIdentifier(runId, "runId");
		if (workflowName !== undefined) validateIdentifier(workflowName, "workflowName");
		const row = (workflowName === undefined
			? this.database
				.query(
					`SELECT workflow_name, run_id, key_version, cipher_version,
					        snapshot_nonce AS nonce, snapshot_ciphertext AS ciphertext,
					        created_at_ms, updated_at_ms
					 FROM mastra_workflow_snapshots
					 WHERE account_id = ? AND run_id = ?
					 ORDER BY updated_at_ms DESC, workflow_name ASC LIMIT 1`,
				)
				.get(accountId, runId)
			: this.database
				.query(
					`SELECT workflow_name, run_id, key_version, cipher_version,
					        snapshot_nonce AS nonce, snapshot_ciphertext AS ciphertext,
					        created_at_ms, updated_at_ms
					 FROM mastra_workflow_snapshots
					 WHERE account_id = ? AND run_id = ? AND workflow_name = ?`,
				)
				.get(accountId, runId, workflowName)) as WorkflowSnapshotRow | null;
		return row ? this.workflowSnapshotFromRow(accountId, row) : null;
	}

	async listWorkflowSnapshots(
		accountId: string,
		options: AgentWorkflowSnapshotListOptions = {},
	): Promise<AgentWorkflowSnapshotListResult> {
		validateIdentifier(accountId, "accountId");
		if (options.workflowName !== undefined) validateIdentifier(options.workflowName, "workflowName");
		if (options.resourceId !== undefined && options.resourceId !== accountId) {
			return { runs: [], total: 0 };
		}
		if (options.fromDateMs !== undefined) validateTimestamp(options.fromDateMs, "fromDateMs");
		if (options.toDateMs !== undefined) validateTimestamp(options.toDateMs, "toDateMs");
		if (
			options.fromDateMs !== undefined &&
			options.toDateMs !== undefined &&
			options.fromDateMs > options.toDateMs
		) {
			throw invalidArgument("Workflow snapshot date range is invalid.");
		}
		if (options.page !== undefined && (!Number.isSafeInteger(options.page) || options.page < 0)) {
			throw invalidArgument("Workflow snapshot page is invalid.");
		}
		if (options.perPage !== undefined && options.perPage !== false) validateLimit(options.perPage);
		if (options.status !== undefined) validateText(options.status, "workflow status");
		const rows = this.database
			.query(
				`SELECT workflow_name, run_id, key_version, cipher_version,
				        snapshot_nonce AS nonce, snapshot_ciphertext AS ciphertext,
				        created_at_ms, updated_at_ms
				 FROM mastra_workflow_snapshots
				 WHERE account_id = ?
				   AND (? IS NULL OR workflow_name = ?)
				   AND (? IS NULL OR created_at_ms >= ?)
				   AND (? IS NULL OR created_at_ms <= ?)
				 ORDER BY created_at_ms DESC, run_id DESC
				 LIMIT ?`,
			)
			.all(
				accountId,
				options.workflowName ?? null,
				options.workflowName ?? null,
				options.fromDateMs ?? null,
				options.fromDateMs ?? null,
				options.toDateMs ?? null,
				options.toDateMs ?? null,
				MAX_LIST_LIMIT,
			) as WorkflowSnapshotRow[];
		let records = await Promise.all(
			rows.map((row) => this.workflowSnapshotFromRow(accountId, row)),
		);
		if (options.status !== undefined) {
			records = records.filter(
				(record) => isRecord(record.snapshot) && record.snapshot.status === options.status,
			);
		}
		const total = records.length;
		if (
			options.perPage !== undefined &&
			options.perPage !== false &&
			options.page !== undefined
		) {
			const offset = options.page * options.perPage;
			records = records.slice(offset, offset + options.perPage);
		}
		return { runs: records, total };
	}

	async deleteWorkflowSnapshot(
		accountId: string,
		runId: string,
		workflowName: string,
	): Promise<boolean> {
		validateIdentifier(accountId, "accountId");
		validateIdentifier(runId, "runId");
		validateIdentifier(workflowName, "workflowName");
		const result = this.database
			.query(
				`DELETE FROM mastra_workflow_snapshots
				 WHERE account_id = ? AND workflow_name = ? AND run_id = ?`,
			)
			.run(accountId, workflowName, runId);
		return result.changes > 0;
	}

	async putRun(record: AgentRunRecord): Promise<AgentRunRecord> {
		validateRun(record);
		const [input, output, error] = await Promise.all([
			this.encryptJson(record.accountId, "agent_runs", record.id, "input", record.input),
			record.output === null
				? null
				: this.encryptJson(
						record.accountId,
						"agent_runs",
						record.id,
						"output",
						record.output,
					),
			record.error === null
				? null
				: this.encryptJson(
						record.accountId,
						"agent_runs",
						record.id,
						"error",
						record.error,
					),
		]);
		this.database
			.query(
				`INSERT INTO agent_runs
				 (account_id, run_id, conversation_id, workflow_id, status,
				  input_key_version, input_cipher_version, input_nonce, input_ciphertext,
				  output_key_version, output_cipher_version, output_nonce, output_ciphertext,
				  error_key_version, error_cipher_version, error_nonce, error_ciphertext,
				  created_at_ms, updated_at_ms, completed_at_ms)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(account_id, run_id) DO UPDATE SET
				  conversation_id = excluded.conversation_id,
				  workflow_id = excluded.workflow_id,
				  status = excluded.status,
				  input_key_version = excluded.input_key_version,
				  input_cipher_version = excluded.input_cipher_version,
				  input_nonce = excluded.input_nonce,
				  input_ciphertext = excluded.input_ciphertext,
				  output_key_version = excluded.output_key_version,
				  output_cipher_version = excluded.output_cipher_version,
				  output_nonce = excluded.output_nonce,
				  output_ciphertext = excluded.output_ciphertext,
				  error_key_version = excluded.error_key_version,
				  error_cipher_version = excluded.error_cipher_version,
				  error_nonce = excluded.error_nonce,
				  error_ciphertext = excluded.error_ciphertext,
				  created_at_ms = excluded.created_at_ms,
				  updated_at_ms = excluded.updated_at_ms,
				  completed_at_ms = excluded.completed_at_ms`,
			)
			.run(
				record.accountId,
				record.id,
				record.conversationId,
				record.workflowId,
				record.status,
				input.keyVersion,
				input.cipherVersion,
				input.nonce,
				input.ciphertext,
				output?.keyVersion ?? null,
				output?.cipherVersion ?? null,
				output?.nonce ?? null,
				output?.ciphertext ?? null,
				error?.keyVersion ?? null,
				error?.cipherVersion ?? null,
				error?.nonce ?? null,
				error?.ciphertext ?? null,
				record.createdAtMs,
				record.updatedAtMs,
				record.completedAtMs,
			);
		return structuredClone(record);
	}

	async getRun(accountId: string, runId: string): Promise<AgentRunRecord | null> {
		validateIdentifier(accountId, "accountId");
		validateIdentifier(runId, "runId");
		const row = this.database
			.query("SELECT * FROM agent_runs WHERE account_id = ? AND run_id = ?")
			.get(accountId, runId) as RunRow | null;
		return row ? this.runFromRow(accountId, row) : null;
	}

	async listRuns(accountId: string, limit = 100): Promise<AgentRunRecord[]> {
		validateIdentifier(accountId, "accountId");
		validateLimit(limit);
		const rows = this.database
			.query(
				`SELECT * FROM agent_runs WHERE account_id = ?
				 ORDER BY updated_at_ms DESC, run_id DESC LIMIT ?`,
			)
			.all(accountId, limit) as RunRow[];
		return Promise.all(rows.map((row) => this.runFromRow(accountId, row)));
	}

	async putCalendarEvent(
		record: AgentCalendarEventRecord,
	): Promise<AgentCalendarEventRecord> {
		validateCalendarRecord(record);
		const prepared = await this.prepareCalendarEvent(record);
		const transaction = this.database.transaction(() => {
			this.upsertPreparedCalendarEvent(prepared);
			this.incrementCalendarRevision(record.accountId);
		});
		transaction.immediate();
		return structuredClone(record);
	}

	async getCalendarEvent(
		accountId: string,
		eventId: string,
	): Promise<AgentCalendarEventRecord | null> {
		validateIdentifier(accountId, "accountId");
		validateIdentifier(eventId, "eventId");
		const row = this.database
			.query(
				`SELECT event_id, key_version, cipher_version,
				        event_nonce AS nonce, event_ciphertext AS ciphertext,
				        start_date, end_date_exclusive, updated_at_ms
				 FROM calendar_events WHERE account_id = ? AND event_id = ?`,
			)
			.get(accountId, eventId) as CalendarEventRow | null;
		return row ? this.calendarEventFromRow(accountId, row) : null;
	}

	async listCalendarEvents(
		accountId: string,
		options: CalendarEventListOptions = {},
	): Promise<AgentCalendarEventRecord[]> {
		validateIdentifier(accountId, "accountId");
		const limit = options.limit ?? 500;
		validateLimit(limit);
		const offset = options.offset ?? 0;
		if (!Number.isSafeInteger(offset) || offset < 0) {
			throw invalidArgument("Calendar query offset is invalid.");
		}
		if (options.from !== undefined) validateDateOnly(options.from, "from");
		if (options.to !== undefined) validateDateOnly(options.to, "to");
		if (options.from !== undefined && options.to !== undefined && options.from >= options.to) {
			throw invalidArgument("Calendar query range is invalid.");
		}
		const rows = this.database
			.query(
				`SELECT event_id, key_version, cipher_version,
				        event_nonce AS nonce, event_ciphertext AS ciphertext,
				        start_date, end_date_exclusive, updated_at_ms
				 FROM calendar_events
				 WHERE account_id = ?
				   AND (? IS NULL OR end_date_exclusive > ?)
				   AND (? IS NULL OR start_date < ?)
				 ORDER BY start_date ASC, event_id ASC LIMIT ? OFFSET ?`,
			)
			.all(
				accountId,
				options.from ?? null,
				options.from ?? null,
				options.to ?? null,
				options.to ?? null,
				limit,
				offset,
			) as CalendarEventRow[];
		return Promise.all(rows.map((row) => this.calendarEventFromRow(accountId, row)));
	}

	async deleteCalendarEvent(accountId: string, eventId: string): Promise<boolean> {
		await this.accountContext(accountId);
		validateIdentifier(eventId, "eventId");
		const transaction = this.database.transaction(() => {
			const result = this.database
				.query("DELETE FROM calendar_events WHERE account_id = ? AND event_id = ?")
				.run(accountId, eventId);
			if (result.changes === 1) this.incrementCalendarRevision(accountId);
			return result.changes === 1;
		});
		return transaction.immediate();
	}

	async getCalendarRevision(accountId: string): Promise<number> {
		await this.accountContext(accountId);
		return this.readCalendarRevision(accountId);
	}

	async getPlanningAuthority(
		accountId: string,
	): Promise<PlanningAuthoritySnapshot | null> {
		validateIdentifier(accountId, "accountId");
		await this.accountContext(accountId);
		const row = this.database
			.query(
				`SELECT revision, status, last_commit_id, last_commit_digest,
				        commit_calendar_revision, key_version, cipher_version,
				        state_nonce AS nonce, state_ciphertext AS ciphertext,
				        updated_at_ms
				 FROM planning_authority WHERE account_id = ?`,
			)
			.get(accountId) as PlanningAuthorityRow | null;
		if (!row) return null;
		const value = await this.decryptJson(
			accountId,
			"planning_authority",
			"current",
			"state",
			row,
		);
		if (!isPlanningAuthoritySnapshot(value)) throw decryptionFailure();
		if (
			value.revision !== row.revision ||
			value.status !== row.status ||
			value.updatedAtMs !== row.updated_at_ms ||
			(value.commit?.commitId ?? null) !== row.last_commit_id ||
			(value.commit?.calendarRevision ?? null) !== row.commit_calendar_revision ||
			planningSnapshotCommitDigest(value) !== row.last_commit_digest
		) {
			throw decryptionFailure();
		}
		return structuredClone(value);
	}

	async compareAndSetPlanningAuthority(
		accountId: string,
		snapshot: PlanningAuthoritySnapshot,
		expectedRevision: number | null,
		beforeCommit?: () => void,
	): Promise<boolean> {
		validateIdentifier(accountId, "accountId");
		validatePlanningAuthoritySnapshot(snapshot);
		if (expectedRevision === null) {
			if (snapshot.revision !== 1) {
				throw invalidArgument("A new planning authority must start at revision 1.");
			}
		} else {
			validateRevision(expectedRevision);
			if (snapshot.revision !== expectedRevision + 1) {
				throw invalidArgument("Planning authority revision must increment exactly once.");
			}
		}
		const cipher = await this.encryptJson(
			accountId,
			"planning_authority",
			"current",
			"state",
			snapshot,
		);
		const commitDigest = planningSnapshotCommitDigest(snapshot);
		const transaction = this.database.transaction(() => {
			beforeCommit?.();
			const current = this.database
				.query("SELECT revision FROM planning_authority WHERE account_id = ?")
				.get(accountId) as { revision: number } | null;
			if ((current?.revision ?? null) !== expectedRevision) return false;
			const result = this.database
				.query(
					`INSERT INTO planning_authority
					 (account_id, revision, status, last_commit_id, last_commit_digest,
					  commit_calendar_revision, key_version, cipher_version,
					  state_nonce, state_ciphertext, updated_at_ms)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(account_id) DO UPDATE SET
					  revision = excluded.revision,
					  status = excluded.status,
					  last_commit_digest = excluded.last_commit_digest,
					  last_commit_id = excluded.last_commit_id,
					  commit_calendar_revision = excluded.commit_calendar_revision,
					  key_version = excluded.key_version,
					  cipher_version = excluded.cipher_version,
					  state_nonce = excluded.state_nonce,
					  state_ciphertext = excluded.state_ciphertext,
					  updated_at_ms = excluded.updated_at_ms`,
				)
				.run(
					accountId,
					snapshot.revision,
					snapshot.status,
					snapshot.commit?.commitId ?? null,
					commitDigest,
					snapshot.commit?.calendarRevision ?? null,
					cipher.keyVersion,
					cipher.cipherVersion,
					cipher.nonce,
					cipher.ciphertext,
					snapshot.updatedAtMs,
				);
			return result.changes === 1;
		});
		return transaction.immediate();
	}

	/**
	 * Commits calendar events and the confirmed planning aggregate in one SQLite
	 * IMMEDIATE transaction. Encryption is prepared before the transaction; both
	 * optimistic revisions are checked again while the write lock is held.
	 */
	async commitCalendarAndPlanningAuthority(
		accountId: string,
		commit: PlanningCalendarAuthorityCommit,
	): Promise<PlanningCalendarAuthorityCommitResult> {
		validateIdentifier(accountId, "accountId");
		validateIdentifier(commit.commitId, "commitId");
		validateRevision(commit.expectedAuthorityRevision);
		validatePlanningAuthoritySnapshot(commit.authority);
		if (
			commit.authority.revision !== commit.expectedAuthorityRevision + 1 ||
			commit.authority.status !== "committed" ||
			commit.authority.commit?.commitId !== commit.commitId ||
			commit.authority.commit.draftRevision !== commit.expectedAuthorityRevision ||
			commit.authority.commit.draftDigest !==
				planningDraftDigest(commit.authority.input, commit.authority.draft) ||
			commit.authority.commit.calendarRevision !== commit.calendar.expectedRevision + 1
		) {
			throw invalidArgument("Planning authority commit metadata is inconsistent.");
		}
		const { deleteIds, prepared } = await this.prepareCalendarBatch(
			accountId,
			commit.calendar,
		);
		const authorityCipher = await this.encryptJson(
			accountId,
			"planning_authority",
			"current",
			"state",
			commit.authority,
		);
		const digest = planningCommitCoordinationDigest({
			commitId: commit.commitId,
			expectedAuthorityRevision: commit.expectedAuthorityRevision,
			expectedCalendarRevision: commit.calendar.expectedRevision,
			draftRevision: commit.authority.commit.draftRevision,
			draftDigest: commit.authority.commit.draftDigest,
		});
		const transaction = this.database.transaction(() => {
			commit.beforeCommit?.();
			const authorityRow = this.database
				.query(
					`SELECT revision, last_commit_id, last_commit_digest,
					        commit_calendar_revision
					 FROM planning_authority WHERE account_id = ?`,
				)
				.get(accountId) as {
					revision: number;
					last_commit_id: string | null;
					last_commit_digest: string | null;
					commit_calendar_revision: number | null;
				} | null;
			if (!authorityRow) {
				throw new PlanningAuthorityRevisionConflictError(
					commit.expectedAuthorityRevision,
					0,
				);
			}
			if (authorityRow.last_commit_id === commit.commitId) {
				if (authorityRow.last_commit_digest !== digest) {
					throw invalidArgument("Planning commit ID was reused for different content.");
				}
				return {
					calendarRevision: authorityRow.commit_calendar_revision!,
					authorityRevision: authorityRow.revision,
					idempotent: true,
				};
			}
			if (authorityRow.revision !== commit.expectedAuthorityRevision) {
				throw new PlanningAuthorityRevisionConflictError(
					commit.expectedAuthorityRevision,
					authorityRow.revision,
				);
			}
			const actualCalendarRevision = this.readCalendarRevision(accountId);
			if (actualCalendarRevision !== commit.calendar.expectedRevision) {
				throw new CalendarRevisionConflictError(
					commit.calendar.expectedRevision,
					actualCalendarRevision,
				);
			}
			for (const event of prepared) this.upsertPreparedCalendarEvent(event);
			for (const eventId of deleteIds) {
				this.database
					.query("DELETE FROM calendar_events WHERE account_id = ? AND event_id = ?")
					.run(accountId, eventId);
			}
			const calendarRevision = actualCalendarRevision + 1;
			this.database
				.query(
					"UPDATE calendar_revisions SET revision = ?, updated_at_ms = ? WHERE account_id = ?",
				)
				.run(calendarRevision, commit.authority.updatedAtMs, accountId);
			const updated = this.database
				.query(
					`UPDATE planning_authority SET
					 revision = ?, status = ?, last_commit_id = ?,
					 last_commit_digest = ?, commit_calendar_revision = ?,
					 key_version = ?, cipher_version = ?, state_nonce = ?,
					 state_ciphertext = ?, updated_at_ms = ?
					 WHERE account_id = ? AND revision = ?`,
				)
				.run(
					commit.authority.revision,
					commit.authority.status,
					commit.commitId,
					digest,
					calendarRevision,
					authorityCipher.keyVersion,
					authorityCipher.cipherVersion,
					authorityCipher.nonce,
					authorityCipher.ciphertext,
					commit.authority.updatedAtMs,
					accountId,
					commit.expectedAuthorityRevision,
				);
			if (updated.changes !== 1) {
				throw new PlanningAuthorityRevisionConflictError(
					commit.expectedAuthorityRevision,
					authorityRow.revision,
				);
			}
			return {
				calendarRevision,
				authorityRevision: commit.authority.revision,
				idempotent: false,
			};
		});
		return transaction.immediate();
	}

	async commitCalendarBatch(
		accountId: string,
		batch: CalendarBatchCommit,
	): Promise<{ revision: number }> {
		const { deleteIds, prepared } = await this.prepareCalendarBatch(accountId, batch);
		const transaction = this.database.transaction(() => {
			const actualRevision = this.readCalendarRevision(accountId);
			if (actualRevision !== batch.expectedRevision) {
				throw new CalendarRevisionConflictError(
					batch.expectedRevision,
					actualRevision,
				);
			}
			for (const event of prepared) this.upsertPreparedCalendarEvent(event);
			for (const eventId of deleteIds) {
				this.database
					.query("DELETE FROM calendar_events WHERE account_id = ? AND event_id = ?")
					.run(accountId, eventId);
			}
			const revision = actualRevision + 1;
			this.database
				.query(
					"UPDATE calendar_revisions SET revision = ?, updated_at_ms = ? WHERE account_id = ?",
				)
				.run(revision, this.now(), accountId);
			return { revision };
		});
		return transaction.immediate();
	}

	private async conversationFromRow(
		accountId: string,
		row: ConversationRow,
	): Promise<AgentConversationRecord> {
		return {
			accountId,
			id: row.conversation_id,
			title: await this.decryptText(
				accountId,
				"conversations",
				row.conversation_id,
				"title",
				row,
			),
			createdAtMs: row.created_at_ms,
			updatedAtMs: row.updated_at_ms,
		};
	}

	private async messageFromRow(
		accountId: string,
		row: MessageRow,
	): Promise<AgentMessageRecord> {
		return {
			accountId,
			id: row.message_id,
			conversationId: row.conversation_id,
			clientMessageId: row.client_message_id,
			runId: row.run_id,
			role: row.role,
			status: row.status,
			content: await this.decryptText(
				accountId,
				"messages",
				row.message_id,
				"content",
				row,
			),
			createdAtMs: row.created_at_ms,
		};
	}

	private async workflowFromRow(
		accountId: string,
		row: WorkflowRow,
	): Promise<AgentWorkflowRecord> {
		const [name, definition] = await Promise.all([
			this.decryptText(accountId, "workflows", row.workflow_id, "name", {
				key_version: row.name_key_version,
				cipher_version: row.name_cipher_version,
				nonce: row.name_nonce,
				ciphertext: row.name_ciphertext,
			}),
			this.decryptJson(accountId, "workflows", row.workflow_id, "definition", {
				key_version: row.definition_key_version,
				cipher_version: row.definition_cipher_version,
				nonce: row.definition_nonce,
				ciphertext: row.definition_ciphertext,
			}),
		]);
		return {
			accountId,
			id: row.workflow_id,
			name,
			definition,
			enabled: row.enabled === 1,
			createdAtMs: row.created_at_ms,
			updatedAtMs: row.updated_at_ms,
		};
	}

	private async workflowSnapshotFromRow(
		accountId: string,
		row: WorkflowSnapshotRow,
	): Promise<AgentWorkflowSnapshotRecord> {
		const snapshot = await this.decryptJson(
			accountId,
			"mastra_workflow_snapshots",
			workflowSnapshotRowId(row.workflow_name, row.run_id),
			"snapshot",
			row,
		);
		return {
			accountId,
			workflowName: row.workflow_name,
			runId: row.run_id,
			resourceId: accountId,
			snapshot,
			createdAtMs: row.created_at_ms,
			updatedAtMs: row.updated_at_ms,
		};
	}

	private async runFromRow(accountId: string, row: RunRow): Promise<AgentRunRecord> {
		const [input, output, error] = await Promise.all([
			this.decryptJson(accountId, "agent_runs", row.run_id, "input", {
				key_version: row.input_key_version,
				cipher_version: row.input_cipher_version,
				nonce: row.input_nonce,
				ciphertext: row.input_ciphertext,
			}),
			this.decryptOptionalJson(accountId, row, "output"),
			this.decryptOptionalJson(accountId, row, "error"),
		]);
		return {
			accountId,
			id: row.run_id,
			conversationId: row.conversation_id,
			workflowId: row.workflow_id,
			status: row.status,
			input,
			output,
			error,
			createdAtMs: row.created_at_ms,
			updatedAtMs: row.updated_at_ms,
			completedAtMs: row.completed_at_ms,
		};
	}

	private async decryptOptionalJson(
		accountId: string,
		row: RunRow,
		field: "output" | "error",
	): Promise<unknown | null> {
		const keyVersion = row[`${field}_key_version`];
		const cipherVersion = row[`${field}_cipher_version`];
		const nonce = row[`${field}_nonce`];
		const ciphertext = row[`${field}_ciphertext`];
		if (
			keyVersion === null ||
			cipherVersion === null ||
			nonce === null ||
			ciphertext === null
		) {
			if (
				keyVersion !== null ||
				cipherVersion !== null ||
				nonce !== null ||
				ciphertext !== null
			) {
				throw decryptionFailure();
			}
			return null;
		}
		return this.decryptJson(accountId, "agent_runs", row.run_id, field, {
			key_version: keyVersion,
			cipher_version: cipherVersion,
			nonce,
			ciphertext,
		});
	}

	private async calendarEventFromRow(
		accountId: string,
		row: CalendarEventRow,
	): Promise<AgentCalendarEventRecord> {
		const event = await this.decryptJson(
			accountId,
			"calendar_events",
			row.event_id,
			"event",
			row,
		);
		if (!isCalendarEvent(event) || event.id !== row.event_id) {
			throw decryptionFailure();
		}
		return { accountId, event, updatedAtMs: row.updated_at_ms };
	}

	private async prepareCalendarEvent(
		record: AgentCalendarEventRecord,
	): Promise<PreparedCalendarEvent> {
		const cipher = await this.encryptJson(
			record.accountId,
			"calendar_events",
			record.event.id,
			"event",
			record.event,
		);
		const [startDate, endDateExclusive] = calendarDateRange(record.event);
		return { record, cipher, startDate, endDateExclusive };
	}

	private async prepareCalendarBatch(
		accountId: string,
		batch: CalendarBatchCommit,
	): Promise<{
		deleteIds: Set<string>;
		prepared: PreparedCalendarEvent[];
	}> {
		validateIdentifier(accountId, "accountId");
		validateRevision(batch.expectedRevision);
		const deleteIds = new Set<string>();
		for (const eventId of batch.deletes) {
			validateIdentifier(eventId, "eventId");
			if (deleteIds.has(eventId)) {
				throw invalidArgument("Calendar batch contains a duplicate delete id.");
			}
			deleteIds.add(eventId);
		}
		const upsertIds = new Set<string>();
		for (const record of batch.upserts) {
			validateCalendarRecord(record);
			if (record.accountId !== accountId) {
				throw invalidArgument("Calendar batch mixes account ids.");
			}
			if (upsertIds.has(record.event.id) || deleteIds.has(record.event.id)) {
				throw invalidArgument("Calendar batch contains conflicting event operations.");
			}
			upsertIds.add(record.event.id);
		}
		return {
			deleteIds,
			prepared: await Promise.all(
				batch.upserts.map((record) => this.prepareCalendarEvent(record)),
			),
		};
	}

	private upsertPreparedCalendarEvent(prepared: PreparedCalendarEvent): void {
		const { record, cipher, startDate, endDateExclusive } = prepared;
		this.database
			.query(
				`INSERT INTO calendar_events
				 (account_id, event_id, key_version, cipher_version, event_nonce,
				  event_ciphertext, start_date, end_date_exclusive, updated_at_ms)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(account_id, event_id) DO UPDATE SET
				  key_version = excluded.key_version,
				  cipher_version = excluded.cipher_version,
				  event_nonce = excluded.event_nonce,
				  event_ciphertext = excluded.event_ciphertext,
				  start_date = excluded.start_date,
				  end_date_exclusive = excluded.end_date_exclusive,
				  updated_at_ms = excluded.updated_at_ms`,
			)
			.run(
				record.accountId,
				record.event.id,
				cipher.keyVersion,
				cipher.cipherVersion,
				cipher.nonce,
				cipher.ciphertext,
				startDate,
				endDateExclusive,
				record.updatedAtMs,
			);
	}

	private incrementCalendarRevision(accountId: string): number {
		const revision = this.readCalendarRevision(accountId) + 1;
		this.database
			.query(
				"UPDATE calendar_revisions SET revision = ?, updated_at_ms = ? WHERE account_id = ?",
			)
			.run(revision, this.now(), accountId);
		return revision;
	}

	private readCalendarRevision(accountId: string): number {
		const row = this.database
			.query("SELECT revision FROM calendar_revisions WHERE account_id = ?")
			.get(accountId) as { revision: number } | null;
		if (!row) throw invalidArgument("Unknown encrypted account.");
		return row.revision;
	}

	private async encryptText(
		accountId: string,
		table: string,
		recordId: string,
		field: string,
		value: string,
	): Promise<PreparedCipher> {
		return this.encryptBytes(
			accountId,
			table,
			recordId,
			field,
			new TextEncoder().encode(value),
		);
	}

	private async encryptJson(
		accountId: string,
		table: string,
		recordId: string,
		field: string,
		value: unknown,
	): Promise<PreparedCipher> {
		let serialized: string | undefined;
		try {
			serialized = JSON.stringify(value);
		} catch {
			throw serializationFailure();
		}
		if (serialized === undefined) throw serializationFailure();
		return this.encryptText(accountId, table, recordId, field, serialized);
	}

	private async encryptBytes(
		accountId: string,
		table: string,
		recordId: string,
		field: string,
		plaintext: Uint8Array,
	): Promise<PreparedCipher> {
		const context = await this.accountContext(accountId);
		const nonce = webcrypto.getRandomValues(new Uint8Array(NONCE_BYTES));
		const additionalData = aad(
			accountId,
			table,
			recordId,
			field,
			context.keyReference.keyVersion,
		);
		const cryptoPlaintext = new Uint8Array(plaintext);
		try {
			const ciphertext = new Uint8Array(
				await webcrypto.subtle.encrypt(
					{
						name: "AES-GCM",
						iv: nonce,
						additionalData,
						tagLength: 128,
					},
					context.cryptoKey,
					cryptoPlaintext,
				),
			);
			return {
				keyVersion: context.keyReference.keyVersion,
				cipherVersion: CIPHER_VERSION,
				nonce,
				ciphertext,
			};
		} finally {
			additionalData.fill(0);
			cryptoPlaintext.fill(0);
			plaintext.fill(0);
		}
	}

	private async decryptText(
		accountId: string,
		table: string,
		recordId: string,
		field: string,
		cipher: CipherRow,
	): Promise<string> {
		const plaintext = await this.decryptBytes(accountId, table, recordId, field, cipher);
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
		} catch {
			throw decryptionFailure();
		} finally {
			plaintext.fill(0);
		}
	}

	private async decryptJson(
		accountId: string,
		table: string,
		recordId: string,
		field: string,
		cipher: CipherRow,
	): Promise<unknown> {
		const text = await this.decryptText(accountId, table, recordId, field, cipher);
		try {
			return JSON.parse(text) as unknown;
		} catch {
			throw decryptionFailure();
		}
	}

	private async decryptBytes(
		accountId: string,
		table: string,
		recordId: string,
		field: string,
		cipher: CipherRow,
	): Promise<Uint8Array> {
		if (
			cipher.key_version !== KEY_VERSION ||
			cipher.cipher_version !== CIPHER_VERSION ||
			cipher.nonce.byteLength !== NONCE_BYTES ||
			// AES-GCM encrypting an allowed empty assistant partial produces only
			// the 16-byte authentication tag.
			cipher.ciphertext.byteLength < 16
		) {
			throw decryptionFailure();
		}
		const context = await this.accountContext(accountId);
		if (context.keyReference.keyVersion !== cipher.key_version) {
			throw decryptionFailure();
		}
		const additionalData = aad(
			accountId,
			table,
			recordId,
			field,
			cipher.key_version,
		);
		const nonce = new Uint8Array(cipher.nonce);
		const ciphertext = new Uint8Array(cipher.ciphertext);
		try {
			return new Uint8Array(
				await webcrypto.subtle.decrypt(
					{
						name: "AES-GCM",
						iv: nonce,
						additionalData,
						tagLength: 128,
					},
					context.cryptoKey,
					ciphertext,
				),
			);
		} catch {
			throw decryptionFailure();
		} finally {
			additionalData.fill(0);
			nonce.fill(0);
			ciphertext.fill(0);
		}
	}

	private accountContext(accountId: string): Promise<AccountContext> {
		this.requireOpen();
		validateIdentifier(accountId, "accountId");
		const cached = this.accountContexts.get(accountId);
		if (cached) return Promise.resolve(cached);
		const loading = this.accountLoads.get(accountId);
		if (loading) return loading;
		const request = this.loadAccountContext(accountId).finally(() => {
			if (this.accountLoads.get(accountId) === request) {
				this.accountLoads.delete(accountId);
			}
		});
		this.accountLoads.set(accountId, request);
		return request;
	}

	private async loadAccountContext(accountId: string): Promise<AccountContext> {
		let row = this.accountRow(accountId);
		if (row?.state === "deleting") {
			throw new EncryptedAgentRepositoryError(
				"ACCOUNT_DELETING",
				"The encrypted account is pending deletion.",
			);
		}
		if (!row) {
			const keyId = accountKeyId(accountId);
			const reference = {
				installationId: this.installationId,
				accountId: keyId,
				keyVersion: KEY_VERSION,
			};
			let keyBytes: Uint8Array;
			try {
				keyBytes = await this.keyStore.getKey(reference);
			} catch (error) {
				if (!(error instanceof CredentialHelperError) || error.code !== "NOT_FOUND") {
					throw error;
				}
				try {
					keyBytes = await this.keyStore.createKey(reference);
				} catch (createError) {
					if (
						createError instanceof CredentialHelperError &&
						createError.code === "ALREADY_EXISTS"
					) {
						keyBytes = await this.keyStore.getKey(reference);
					} else {
						throw createError;
					}
				}
			}
			const now = this.now();
			const insert = this.database.transaction(() => {
				this.database
					.query(
						`INSERT OR IGNORE INTO encrypted_accounts
						 (account_id, key_id, key_version, state, created_at_ms, updated_at_ms)
						 VALUES (?, ?, ?, 'active', ?, ?)`,
					)
					.run(accountId, keyId, KEY_VERSION, now, now);
				this.database
					.query(
						`INSERT OR IGNORE INTO calendar_revisions
						 (account_id, revision, updated_at_ms) VALUES (?, 0, ?)`,
					)
					.run(accountId, now);
			});
			insert.immediate();
			row = this.accountRow(accountId);
			if (!row || row.key_id !== keyId || row.key_version !== KEY_VERSION) {
				keyBytes.fill(0);
				throw decryptionFailure();
			}
			const context = await importContextKey(reference, keyBytes);
			this.accountContexts.set(accountId, context);
			return context;
		}

		const reference = {
			installationId: this.installationId,
			accountId: row.key_id,
			keyVersion: row.key_version,
		};
		let keyBytes: Uint8Array;
		try {
			keyBytes = await this.keyStore.getKey(reference);
		} catch (error) {
			if (error instanceof CredentialHelperError && error.code === "NOT_FOUND") {
				throw new EncryptedAgentRepositoryError(
					"ACCOUNT_KEY_MISSING",
					"Encrypted account data exists but its OS credential key is missing.",
				);
			}
			throw error;
		}
		const context = await importContextKey(reference, keyBytes);
		this.accountContexts.set(accountId, context);
		return context;
	}

	private accountRow(accountId: string): AccountRow | null {
		return this.database
			.query(
				"SELECT key_id, key_version, state FROM encrypted_accounts WHERE account_id = ?",
			)
			.get(accountId) as AccountRow | null;
	}

	private requireOpen(): void {
		if (this.closed) throw new Error("EncryptedAgentRepository is closed.");
	}

	private configure(): void {
		this.database.exec("PRAGMA journal_mode = WAL;");
		this.database.exec("PRAGMA synchronous = FULL;");
		this.database.exec("PRAGMA foreign_keys = ON;");
		this.database.exec("PRAGMA secure_delete = ON;");
		this.database.exec("PRAGMA busy_timeout = 5000;");
		this.database.exec("PRAGMA trusted_schema = OFF;");
	}

	private migrate(): void {
		const migration = this.database.transaction(() => {
			this.database.exec(`
				CREATE TABLE IF NOT EXISTS encrypted_agent_schema (
					singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
					version INTEGER NOT NULL
				);
			`);
			const schema = this.database
				.query("SELECT version FROM encrypted_agent_schema WHERE singleton = 1")
				.get() as { version: number } | null;
			if (schema && schema.version !== DATABASE_SCHEMA_VERSION) {
				throw new EncryptedAgentRepositoryError(
					"SCHEMA_UNSUPPORTED",
					`Unsupported encrypted Agent schema version: ${schema.version}.`,
				);
			}
			this.database.exec(`
				CREATE TABLE IF NOT EXISTS encrypted_accounts (
					account_id TEXT PRIMARY KEY,
					key_id TEXT NOT NULL UNIQUE,
					key_version INTEGER NOT NULL CHECK (key_version > 0),
					state TEXT NOT NULL CHECK (state IN ('active', 'deleting')),
					created_at_ms INTEGER NOT NULL,
					updated_at_ms INTEGER NOT NULL
				);

				CREATE TABLE IF NOT EXISTS conversations (
					account_id TEXT NOT NULL,
					conversation_id TEXT NOT NULL,
					key_version INTEGER NOT NULL,
					cipher_version INTEGER NOT NULL,
					title_nonce BLOB NOT NULL,
					title_ciphertext BLOB NOT NULL,
					created_at_ms INTEGER NOT NULL,
					updated_at_ms INTEGER NOT NULL,
					PRIMARY KEY (account_id, conversation_id),
					FOREIGN KEY (account_id) REFERENCES encrypted_accounts(account_id) ON DELETE CASCADE
				);

				CREATE TABLE IF NOT EXISTS messages (
					account_id TEXT NOT NULL,
					message_id TEXT NOT NULL,
					conversation_id TEXT NOT NULL,
					client_message_id TEXT,
					run_id TEXT,
					role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
					status TEXT NOT NULL CHECK (status IN ('complete', 'partial', 'cancelled', 'failed', 'interrupted')),
					key_version INTEGER NOT NULL,
					cipher_version INTEGER NOT NULL,
					content_nonce BLOB NOT NULL,
					content_ciphertext BLOB NOT NULL,
					created_at_ms INTEGER NOT NULL,
					PRIMARY KEY (account_id, message_id),
					FOREIGN KEY (account_id, conversation_id)
						REFERENCES conversations(account_id, conversation_id) ON DELETE CASCADE
				);
				CREATE INDEX IF NOT EXISTS messages_by_conversation
					ON messages(account_id, conversation_id, created_at_ms, message_id);
				CREATE UNIQUE INDEX IF NOT EXISTS messages_by_client_id
					ON messages(account_id, client_message_id)
					WHERE client_message_id IS NOT NULL;
				CREATE INDEX IF NOT EXISTS messages_by_run
					ON messages(account_id, run_id, created_at_ms, message_id)
					WHERE run_id IS NOT NULL;

				CREATE TABLE IF NOT EXISTS workflows (
					account_id TEXT NOT NULL,
					workflow_id TEXT NOT NULL,
					name_key_version INTEGER NOT NULL,
					name_cipher_version INTEGER NOT NULL,
					name_nonce BLOB NOT NULL,
					name_ciphertext BLOB NOT NULL,
					definition_key_version INTEGER NOT NULL,
					definition_cipher_version INTEGER NOT NULL,
					definition_nonce BLOB NOT NULL,
					definition_ciphertext BLOB NOT NULL,
					enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
					created_at_ms INTEGER NOT NULL,
					updated_at_ms INTEGER NOT NULL,
					PRIMARY KEY (account_id, workflow_id),
					FOREIGN KEY (account_id) REFERENCES encrypted_accounts(account_id) ON DELETE CASCADE
				);

				CREATE TABLE IF NOT EXISTS mastra_workflow_snapshots (
					account_id TEXT NOT NULL,
					workflow_name TEXT NOT NULL,
					run_id TEXT NOT NULL,
					key_version INTEGER NOT NULL,
					cipher_version INTEGER NOT NULL,
					snapshot_nonce BLOB NOT NULL,
					snapshot_ciphertext BLOB NOT NULL,
					created_at_ms INTEGER NOT NULL,
					updated_at_ms INTEGER NOT NULL,
					PRIMARY KEY (account_id, workflow_name, run_id),
					FOREIGN KEY (account_id) REFERENCES encrypted_accounts(account_id) ON DELETE CASCADE
				);
				CREATE INDEX IF NOT EXISTS mastra_workflow_snapshots_by_account
					ON mastra_workflow_snapshots(account_id, created_at_ms DESC, run_id);

				CREATE TABLE IF NOT EXISTS agent_runs (
					account_id TEXT NOT NULL,
					run_id TEXT NOT NULL,
					conversation_id TEXT,
					workflow_id TEXT,
					status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'suspended', 'cancelling', 'completed', 'cancelled', 'interrupted', 'failed')),
					input_key_version INTEGER NOT NULL,
					input_cipher_version INTEGER NOT NULL,
					input_nonce BLOB NOT NULL,
					input_ciphertext BLOB NOT NULL,
					output_key_version INTEGER,
					output_cipher_version INTEGER,
					output_nonce BLOB,
					output_ciphertext BLOB,
					error_key_version INTEGER,
					error_cipher_version INTEGER,
					error_nonce BLOB,
					error_ciphertext BLOB,
					created_at_ms INTEGER NOT NULL,
					updated_at_ms INTEGER NOT NULL,
					completed_at_ms INTEGER,
					PRIMARY KEY (account_id, run_id),
					FOREIGN KEY (account_id) REFERENCES encrypted_accounts(account_id) ON DELETE CASCADE
				);

				CREATE TABLE IF NOT EXISTS calendar_revisions (
					account_id TEXT PRIMARY KEY,
					revision INTEGER NOT NULL CHECK (revision >= 0),
					updated_at_ms INTEGER NOT NULL,
					FOREIGN KEY (account_id) REFERENCES encrypted_accounts(account_id) ON DELETE CASCADE
				);

				CREATE TABLE IF NOT EXISTS calendar_events (
					account_id TEXT NOT NULL,
					event_id TEXT NOT NULL,
					key_version INTEGER NOT NULL,
					cipher_version INTEGER NOT NULL,
					event_nonce BLOB NOT NULL,
					event_ciphertext BLOB NOT NULL,
					start_date TEXT NOT NULL,
					end_date_exclusive TEXT NOT NULL,
					updated_at_ms INTEGER NOT NULL,
					PRIMARY KEY (account_id, event_id),
					FOREIGN KEY (account_id) REFERENCES encrypted_accounts(account_id) ON DELETE CASCADE
				);
					CREATE INDEX IF NOT EXISTS calendar_events_by_range
						ON calendar_events(account_id, start_date, end_date_exclusive, event_id);

					CREATE TABLE IF NOT EXISTS planning_authority (
						account_id TEXT PRIMARY KEY,
						revision INTEGER NOT NULL CHECK (revision > 0),
						status TEXT NOT NULL CHECK (status IN ('draft', 'committed')),
						last_commit_id TEXT,
						last_commit_digest TEXT,
						commit_calendar_revision INTEGER,
						key_version INTEGER NOT NULL,
						cipher_version INTEGER NOT NULL,
						state_nonce BLOB NOT NULL,
						state_ciphertext BLOB NOT NULL,
						updated_at_ms INTEGER NOT NULL,
						CHECK (
							(last_commit_id IS NULL AND last_commit_digest IS NULL AND commit_calendar_revision IS NULL)
							OR
							(last_commit_id IS NOT NULL AND last_commit_digest IS NOT NULL AND commit_calendar_revision IS NOT NULL)
						),
						FOREIGN KEY (account_id) REFERENCES encrypted_accounts(account_id) ON DELETE CASCADE
					);

					CREATE TABLE IF NOT EXISTS agent_tool_grants (
					account_id TEXT NOT NULL,
					permission TEXT NOT NULL CHECK (permission IN ('agent.calendar.read', 'agent.planning.read')),
					updated_at_ms INTEGER NOT NULL,
					PRIMARY KEY (account_id, permission),
					FOREIGN KEY (account_id) REFERENCES encrypted_accounts(account_id) ON DELETE CASCADE
				);

				CREATE TABLE IF NOT EXISTS agent_permission_revisions (
					account_id TEXT PRIMARY KEY,
					revision INTEGER NOT NULL CHECK (revision >= 0),
					updated_at_ms INTEGER NOT NULL,
					FOREIGN KEY (account_id) REFERENCES encrypted_accounts(account_id) ON DELETE CASCADE
				);

				CREATE TABLE IF NOT EXISTS tool_approvals (
					account_id TEXT NOT NULL,
					approval_id TEXT NOT NULL,
					run_id TEXT NOT NULL,
					tool_call_id TEXT NOT NULL,
					tool_name TEXT NOT NULL CHECK (tool_name IN (
						'planning.save_draft',
						'calendar.create_event',
						'calendar.update_event',
						'calendar.delete_event',
						'calendar.commit_plan_schedule'
					)),
					arguments_digest TEXT NOT NULL,
					run_revision INTEGER NOT NULL CHECK (run_revision >= 0),
					arguments_key_version INTEGER NOT NULL,
					arguments_cipher_version INTEGER NOT NULL,
					arguments_nonce BLOB NOT NULL,
					arguments_ciphertext BLOB NOT NULL,
					created_at_ms INTEGER NOT NULL,
					expires_at_ms INTEGER NOT NULL,
					status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
					PRIMARY KEY (account_id, approval_id),
					FOREIGN KEY (account_id) REFERENCES encrypted_accounts(account_id) ON DELETE CASCADE
				);
				CREATE INDEX IF NOT EXISTS tool_approvals_by_status
					ON tool_approvals(account_id, status, expires_at_ms, approval_id);
			`);
			if (!schema) {
				this.database
					.query(
						"INSERT INTO encrypted_agent_schema(singleton, version) VALUES (1, ?)",
					)
					.run(DATABASE_SCHEMA_VERSION);
			}
		});
		migration.immediate();
	}
}

async function importContextKey(
	keyReference: CredentialKeyReference,
	keyBytes: Uint8Array,
): Promise<AccountContext> {
	if (keyBytes.byteLength !== 32) {
		keyBytes.fill(0);
		throw decryptionFailure();
	}
	const rawKey = new Uint8Array(keyBytes);
	try {
		const cryptoKey = await webcrypto.subtle.importKey(
			"raw",
			rawKey,
			{ name: "AES-GCM" },
			false,
			["encrypt", "decrypt"],
		);
		return { keyReference, cryptoKey };
	} finally {
		rawKey.fill(0);
		keyBytes.fill(0);
	}
}

function aad(
	accountId: string,
	table: string,
	recordId: string,
	field: string,
	keyVersion: number,
): Uint8Array<ArrayBuffer> {
	return new TextEncoder().encode(
		[
			"whalehall.encrypted-agent",
			`schema=${DATABASE_SCHEMA_VERSION}`,
			`cipher=${CIPHER_VERSION}`,
			`key=${keyVersion}`,
			`account=${accountId}`,
			`table=${table}`,
			`record=${recordId}`,
			`field=${field}`,
		].join("\u0000"),
	);
}

function accountKeyId(accountId: string): string {
	return createHash("sha256").update(accountId, "utf8").digest("hex");
}

function calendarDateRange(event: CalendarEvent): [string, string] {
	if (event.schedule.allDay) {
		validateDateOnly(event.schedule.startDate, "calendar startDate");
		validateDateOnly(
			event.schedule.endDateExclusive,
			"calendar endDateExclusive",
		);
		return [event.schedule.startDate, event.schedule.endDateExclusive];
	}
	const startMs = parseInstant(event.schedule.start, "calendar start");
	const endMs = parseInstant(event.schedule.end, "calendar end");
	if (startMs >= endMs) throw invalidArgument("Calendar event range is invalid.");
	const start = zonedDateParts(startMs, event.schedule.timeZone);
	const end = zonedDateParts(endMs, event.schedule.timeZone);
	return [
		start.date,
		end.atMidnight ? end.date : addDateOnlyDays(end.date, 1),
	];
}

function isCalendarEvent(value: unknown): value is CalendarEvent {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.title !== "string") {
		return false;
	}
	if (!isRecord(value.schedule) || typeof value.schedule.allDay !== "boolean") return false;
	if (value.schedule.allDay) {
		return (
			typeof value.schedule.startDate === "string" &&
			typeof value.schedule.endDateExclusive === "string"
		);
	}
	return (
		typeof value.schedule.start === "string" &&
		typeof value.schedule.end === "string" &&
		typeof value.schedule.timeZone === "string"
	);
}

function validateConversation(record: AgentConversationRecord): void {
	validateIdentifier(record.accountId, "accountId");
	validateIdentifier(record.id, "conversationId");
	validateText(record.title, "title");
	validateTimestamp(record.createdAtMs, "createdAtMs");
	validateTimestamp(record.updatedAtMs, "updatedAtMs");
}

function validateMessage(record: AgentMessageRecord): void {
	validateIdentifier(record.accountId, "accountId");
	validateIdentifier(record.id, "messageId");
	validateIdentifier(record.conversationId, "conversationId");
	if (record.clientMessageId !== null) {
		validateIdentifier(record.clientMessageId, "clientMessageId");
	}
	if (record.runId !== null) validateIdentifier(record.runId, "runId");
	if (!["system", "user", "assistant", "tool"].includes(record.role)) {
		throw invalidArgument("Message role is invalid.");
	}
	if (
		!["complete", "partial", "cancelled", "failed", "interrupted"].includes(
			record.status,
		)
	) {
		throw invalidArgument("Message status is invalid.");
	}
	if (
		record.content !== "" ||
		record.role !== "assistant" ||
		record.status === "complete"
	) {
		validateText(record.content, "content");
	}
	validateTimestamp(record.createdAtMs, "createdAtMs");
}

function validateWorkflow(record: AgentWorkflowRecord): void {
	validateIdentifier(record.accountId, "accountId");
	validateIdentifier(record.id, "workflowId");
	validateText(record.name, "name");
	validateTimestamp(record.createdAtMs, "createdAtMs");
	validateTimestamp(record.updatedAtMs, "updatedAtMs");
}

function validateWorkflowSnapshot(record: AgentWorkflowSnapshotRecord): void {
	validateIdentifier(record.accountId, "accountId");
	validateIdentifier(record.workflowName, "workflowName");
	validateIdentifier(record.runId, "runId");
	validateIdentifier(record.resourceId, "resourceId");
	validateTimestamp(record.createdAtMs, "createdAtMs");
	validateTimestamp(record.updatedAtMs, "updatedAtMs");
	if (record.updatedAtMs < record.createdAtMs) {
		throw invalidArgument("Workflow snapshot update time is invalid.");
	}
}

function validateRun(record: AgentRunRecord): void {
	validateIdentifier(record.accountId, "accountId");
	validateIdentifier(record.id, "runId");
	if (record.conversationId !== null) {
		validateIdentifier(record.conversationId, "conversationId");
	}
	if (record.workflowId !== null) validateIdentifier(record.workflowId, "workflowId");
	if (
		![
			"starting",
			"running",
			"suspended",
			"cancelling",
			"completed",
			"cancelled",
			"interrupted",
			"failed",
		].includes(record.status)
	) {
		throw invalidArgument("Run status is invalid.");
	}
	validateTimestamp(record.createdAtMs, "createdAtMs");
	validateTimestamp(record.updatedAtMs, "updatedAtMs");
	if (record.completedAtMs !== null) {
		validateTimestamp(record.completedAtMs, "completedAtMs");
	}
}

function validateCalendarRecord(record: AgentCalendarEventRecord): void {
	validateIdentifier(record.accountId, "accountId");
	validateIdentifier(record.event.id, "eventId");
	validateText(record.event.title, "event title");
	validateTimestamp(record.updatedAtMs, "updatedAtMs");
	const [start, end] = calendarDateRange(record.event);
	if (start >= end) throw invalidArgument("Calendar event range is invalid.");
}

function validatePlanningAuthoritySnapshot(
	snapshot: PlanningAuthoritySnapshot,
): void {
	if (!isPlanningAuthoritySnapshot(snapshot)) {
		throw invalidArgument("Planning authority state is invalid.");
	}
	if (snapshot.revision < 1) {
		throw invalidArgument("Planning authority revision is invalid.");
	}
	if (snapshot.status === "draft") {
		const hasPreviousCommit = snapshot.commit !== null;
		if (
			(snapshot.confirmedPlan !== null) !== hasPreviousCommit ||
			(snapshot.activeGoal !== null) !== hasPreviousCommit ||
			(snapshot.commit?.effect.status === "pending")
		) {
			throw invalidArgument("Draft planning authority has inconsistent previous commit state.");
		}
	} else if (
		snapshot.confirmedPlan === null ||
		snapshot.commit === null ||
		snapshot.activeGoal === null
	) {
		throw invalidArgument("Committed planning authority is incomplete.");
	}
}

function isPlanningAuthoritySnapshot(
	value: unknown,
): value is PlanningAuthoritySnapshot {
	if (!isRecord(value)) return false;
	if (
		value.schemaVersion !== "planning-authority.v1" ||
		!Number.isSafeInteger(value.revision) ||
		(value.revision as number) < 1 ||
		(value.status !== "draft" && value.status !== "committed") ||
		!isRecord(value.input) ||
		!isRecord(value.draft) ||
		(value.confirmedPlan !== null && !isRecord(value.confirmedPlan)) ||
		(value.activeGoal !== null && !isRecord(value.activeGoal)) ||
		(value.commit !== null && !isRecord(value.commit)) ||
		!Number.isSafeInteger(value.updatedAtMs) ||
		(value.updatedAtMs as number) < 0
	) {
		return false;
	}
	if (value.commit !== null) {
		if (
			typeof value.commit.commitId !== "string" ||
			value.commit.commitId.length < 1 ||
			value.commit.commitId.length > 256 ||
			!Number.isSafeInteger(value.commit.draftRevision) ||
			(value.commit.draftRevision as number) < 1 ||
			typeof value.commit.draftDigest !== "string" ||
			!/^[a-f0-9]{64}$/.test(value.commit.draftDigest) ||
			!Number.isSafeInteger(value.commit.calendarRevision) ||
			(value.commit.calendarRevision as number) < 1 ||
			!isRecord(value.commit.effect)
		) {
			return false;
		}
	}
	return true;
}

function planningSnapshotCommitDigest(
	snapshot: PlanningAuthoritySnapshot,
): string | null {
	if (!snapshot.commit) return null;
	return planningCommitCoordinationDigest({
		commitId: snapshot.commit.commitId,
		expectedAuthorityRevision: snapshot.commit.draftRevision,
		expectedCalendarRevision: snapshot.commit.calendarRevision - 1,
		draftRevision: snapshot.commit.draftRevision,
		draftDigest: snapshot.commit.draftDigest,
	});
}

function validatePermission(permission: AgentPermission): void {
	if (
		permission !== "agent.calendar.read" &&
		permission !== "agent.planning.read"
	) {
		throw invalidArgument("Agent permission is invalid.");
	}
}

function validateApproval(approval: PendingToolApproval): void {
	validateIdentifier(approval.accountId, "accountId");
	validateIdentifier(approval.approvalId, "approvalId");
	validateIdentifier(approval.runId, "runId");
	validateIdentifier(approval.toolCallId, "toolCallId");
	if (
		![
			"planning.save_draft",
			"calendar.create_event",
			"calendar.update_event",
			"calendar.delete_event",
			"calendar.commit_plan_schedule",
		].includes(approval.toolName)
	) {
		throw invalidArgument("Approval tool name is invalid.");
	}
	if (!/^[a-f0-9]{64}$/.test(approval.argumentsDigest)) {
		throw invalidArgument("Approval arguments digest is invalid.");
	}
	validateRevision(approval.runRevision);
	if (!isRecord(approval.arguments)) {
		throw invalidArgument("Approval arguments are invalid.");
	}
	validateTimestamp(approval.createdAtMs, "createdAtMs");
	validateTimestamp(approval.expiresAtMs, "expiresAtMs");
	if (approval.expiresAtMs <= approval.createdAtMs) {
		throw invalidArgument("Approval expiry is invalid.");
	}
	validateApprovalStatus(approval.status);
}

function validateApprovalStatus(status: PendingToolApproval["status"]): void {
	if (!["pending", "approved", "denied", "expired"].includes(status)) {
		throw invalidArgument("Approval status is invalid.");
	}
}

function parseInstant(value: string, name: string): number {
	if (
		typeof value !== "string" ||
		value.length > 64 ||
		!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
	) {
		throw invalidArgument(`${name} is invalid.`);
	}
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) throw invalidArgument(`${name} is invalid.`);
	return timestamp;
}

function zonedDateParts(
	timestampMs: number,
	timeZone: string,
): { date: string; atMidnight: boolean } {
	validateText(timeZone, "calendar timeZone");
	let parts: Intl.DateTimeFormatPart[];
	try {
		parts = new Intl.DateTimeFormat("en-US", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hourCycle: "h23",
		}).formatToParts(new Date(timestampMs));
	} catch {
		throw invalidArgument("Calendar timeZone is invalid.");
	}
	const value = (type: Intl.DateTimeFormatPartTypes): string => {
		const part = parts.find((candidate) => candidate.type === type)?.value;
		if (!part) throw invalidArgument("Calendar timeZone conversion failed.");
		return part;
	};
	const year = value("year");
	const month = value("month");
	const day = value("day");
	const hour = value("hour");
	const minute = value("minute");
	const second = value("second");
	return {
		date: `${year}-${month}-${day}`,
		atMidnight:
			hour === "00" &&
			minute === "00" &&
			second === "00" &&
			Math.abs(timestampMs % 1_000) === 0,
	};
}

function validateDateOnly(value: string, name: string): void {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		throw invalidArgument(`${name} must be a date-only value.`);
	}
	const year = Number(value.slice(0, 4));
	const month = Number(value.slice(5, 7));
	const day = Number(value.slice(8, 10));
	const reconstructed = new Date(Date.UTC(year, month - 1, day))
		.toISOString()
		.slice(0, 10);
	if (reconstructed !== value) {
		throw invalidArgument(`${name} must be a valid date-only value.`);
	}
}

function addDateOnlyDays(value: string, days: number): string {
	validateDateOnly(value, "calendar date index");
	const year = Number(value.slice(0, 4));
	const month = Number(value.slice(5, 7));
	const day = Number(value.slice(8, 10));
	return new Date(Date.UTC(year, month - 1, day + days))
		.toISOString()
		.slice(0, 10);
}

function validateIdentifier(value: string, name: string): void {
	if (
		typeof value !== "string" ||
		value.length < 1 ||
		value.length > 256 ||
		/\p{Cc}/u.test(value)
	) {
		throw invalidArgument(`${name} is invalid.`);
	}
}

function validateStorageComponent(value: string, name: string): void {
	if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) {
		throw invalidArgument(`${name} is invalid.`);
	}
}

function validateText(value: string, name: string): void {
	if (typeof value !== "string" || value.length < 1 || value.length > 1_000_000) {
		throw invalidArgument(`${name} is invalid.`);
	}
}

function validateTimestamp(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw invalidArgument(`${name} is invalid.`);
	}
}

function validateRevision(value: number): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw invalidArgument("Calendar revision is invalid.");
	}
}

function validateLimit(limit: number): void {
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
		throw invalidArgument(`List limit must be between 1 and ${MAX_LIST_LIMIT}.`);
	}
}

function invalidArgument(message: string): EncryptedAgentRepositoryError {
	return new EncryptedAgentRepositoryError("INVALID_ARGUMENT", message);
}

function serializationFailure(): EncryptedAgentRepositoryError {
	return new EncryptedAgentRepositoryError(
		"SERIALIZATION_FAILED",
		"Agent data could not be serialized for encrypted storage.",
	);
}

function decryptionFailure(): EncryptedAgentRepositoryError {
	return new EncryptedAgentRepositoryError(
		"DECRYPTION_FAILED",
		"Encrypted Agent data failed authentication or decoding.",
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function workflowSnapshotRowId(workflowName: string, runId: string): string {
	return `${workflowName}\u0000${runId}`;
}

function hardenPath(path: string, mode: number): void {
	try {
		chmodSync(path, mode);
	} catch {
		// Windows and some virtual filesystems do not expose POSIX modes. Secrets
		// remain encrypted with account keys held by the OS credential store.
	}
}
