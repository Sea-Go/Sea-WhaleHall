import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import {
  normalizeMonitoringSettings,
  type MonitoringSettings,
} from "./config.js";
import { buildEditEvent } from "./event-builder.js";
import {
  isSafeDocumentCandidate,
  resolveCanonicalWorkspaceRelativePath,
  validateBridgeDirectory,
} from "./path-policy.js";
import { AtomicJsonlSpool } from "./spool.js";

const SOURCE_INSTANCE_STATE_KEY = "whalehall.sourceInstanceId.v1";

type RuntimeState =
  | { kind: "disabled" }
  | { kind: "untrusted" }
  | { kind: "missingWorkspace" }
  | { kind: "invalidConfiguration"; detail: string }
  | { kind: "active"; includeText: boolean }
  | { kind: "error"; detail: string };

type PendingDocumentChange = {
  workspaceRoot: string;
  documentPath: string;
  scheme: string;
  isUntitled: boolean;
  languageId: string;
  documentVersion: number;
  occurredAtMs: number;
  contentChanges: Array<{
    rangeOffset: number;
    rangeLength: number;
    text: string;
  }>;
};

class MonitoringController implements vscode.Disposable {
  readonly #context: vscode.ExtensionContext;
  readonly #statusBar: vscode.StatusBarItem;
  readonly #sourceInstanceId: string;
  #settings: MonitoringSettings = normalizeMonitoringSettings({});
  #runtimeState: RuntimeState = { kind: "disabled" };
  #documentListener: vscode.Disposable | null = null;
  #spool: AtomicJsonlSpool | null = null;
  #refreshChain: Promise<void> = Promise.resolve();
  #documentChangeChain: Promise<void> = Promise.resolve();
  #shutdownPromise: Promise<void> | null = null;
  #disposed = false;
  #captureEnabled = false;
  #captureGeneration = 0;

  private constructor(
    context: vscode.ExtensionContext,
    sourceInstanceId: string,
  ) {
    this.#context = context;
    this.#sourceInstanceId = sourceInstanceId;
    this.#statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      50,
    );
    this.#statusBar.command = "whalehall.monitoring.showStatus";
    this.#statusBar.name = "WhaleHall edit monitoring";
    this.#statusBar.show();
    context.subscriptions.push(this.#statusBar);
  }

  static async create(
    context: vscode.ExtensionContext,
  ): Promise<MonitoringController> {
    let sourceInstanceId = context.globalState.get<string>(
      SOURCE_INSTANCE_STATE_KEY,
    );
    if (sourceInstanceId === undefined) {
      sourceInstanceId = randomUUID();
      await context.globalState.update(
        SOURCE_INSTANCE_STATE_KEY,
        sourceInstanceId,
      );
    }
    const controller = new MonitoringController(context, sourceInstanceId);
    controller.#registerCommandsAndConfiguration();
    await controller.refresh();
    return controller;
  }

  refresh(): Promise<void> {
    this.#captureEnabled = false;
    this.#refreshChain = this.#refreshChain.then(
      async () => {
        if (this.#disposed) {
          return;
        }
        await this.#applyCurrentConfiguration();
      },
      async () => {
        if (this.#disposed) {
          return;
        }
        await this.#applyCurrentConfiguration();
      },
    );
    return this.#refreshChain;
  }

  async flush(): Promise<void> {
    const spool = this.#spool;
    if (spool === null) {
      void vscode.window.showInformationMessage(
        "WhaleHall edit monitoring is not active; there are no pending events.",
      );
      return;
    }
    try {
      await spool.flush();
      const status = await spool.status();
      void vscode.window.showInformationMessage(
        `WhaleHall flushed the local edit spool (${status.pendingEvents} pending).`,
      );
    } catch (error) {
      this.#haltAfterSpoolError(spool, error);
      void vscode.window.showErrorMessage(
        "WhaleHall could not flush the local edit spool. Check the configured directory and permissions.",
      );
    }
  }

  async showStatus(): Promise<void> {
    const detail = this.#describeRuntimeState();
    const spool = this.#spool;
    if (spool === null) {
      void vscode.window.showInformationMessage(detail);
      return;
    }
    try {
      const status = await spool.status();
      void vscode.window.showInformationMessage(
        `${detail} ${status.pendingEvents} event(s) pending; ${status.segmentCount} sealed segment(s).`,
      );
    } catch {
      void vscode.window.showInformationMessage(detail);
    }
  }

  dispose(): void {
    void this.shutdown();
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise === null) {
      this.#shutdownPromise = (async () => {
        this.#disposed = true;
        await this.#refreshChain.catch(() => undefined);
        await this.#stopMonitoring();
      })();
    }
    return this.#shutdownPromise;
  }

  #registerCommandsAndConfiguration(): void {
    this.#context.subscriptions.push(
      vscode.commands.registerCommand(
        "whalehall.monitoring.showStatus",
        () => this.showStatus(),
      ),
      vscode.commands.registerCommand(
        "whalehall.monitoring.flushSpool",
        () => this.flush(),
      ),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("whalehall.monitoring")) {
          void this.refresh();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.refresh();
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        void this.refresh();
      }),
    );
  }

  #readSettings(): MonitoringSettings {
    const configuration = vscode.workspace.getConfiguration(
      "whalehall.monitoring",
    );
    return normalizeMonitoringSettings({
      enabled: configuration.get<unknown>("enabled"),
      includeText: configuration.get<unknown>("includeText"),
      bridgeDirectory: configuration.get<unknown>("bridgeDirectory"),
    });
  }

  async #applyCurrentConfiguration(): Promise<void> {
    await this.#stopMonitoring();
    this.#settings = this.#readSettings();

    if (!this.#settings.enabled) {
      this.#setRuntimeState({ kind: "disabled" });
      return;
    }
    if (!vscode.workspace.isTrusted) {
      this.#setRuntimeState({ kind: "untrusted" });
      return;
    }
    if (
      vscode.workspace.workspaceFolders === undefined ||
      vscode.workspace.workspaceFolders.length === 0
    ) {
      this.#setRuntimeState({ kind: "missingWorkspace" });
      return;
    }

    const bridgeValidation = validateBridgeDirectory(
      this.#settings.bridgeDirectory,
    );
    if (!bridgeValidation.ok) {
      this.#setRuntimeState({
        kind: "invalidConfiguration",
        detail: bridgeValidation.reason,
      });
      return;
    }

    try {
      let spool: AtomicJsonlSpool | null = null;
      const createdSpool = new AtomicJsonlSpool(bridgeValidation.path, {
        onError: (error) => {
          if (spool !== null) {
            this.#haltAfterSpoolError(spool, error);
          }
        },
      });
      spool = createdSpool;
      await createdSpool.initialize();
      this.#spool = createdSpool;
      this.#captureGeneration += 1;
      const captureGeneration = this.#captureGeneration;
      this.#documentListener = vscode.workspace.onDidChangeTextDocument(
        (event) => {
          this.#enqueueDocumentChange(event, createdSpool, captureGeneration);
        },
      );
      this.#captureEnabled = true;
      this.#setRuntimeState({
        kind: "active",
        includeText: this.#settings.includeText,
      });
    } catch (error) {
      await this.#stopMonitoring();
      this.#setError(error);
    }
  }

  async #stopMonitoring(): Promise<void> {
    this.#captureEnabled = false;
    this.#captureGeneration += 1;
    this.#documentListener?.dispose();
    this.#documentListener = null;
    await this.#documentChangeChain.catch(() => undefined);

    const spool = this.#spool;
    this.#spool = null;
    if (spool !== null) {
      try {
        await spool.close();
      } catch (error) {
        this.#setError(error);
      }
    }
  }

  #enqueueDocumentChange(
    event: vscode.TextDocumentChangeEvent,
    spool: AtomicJsonlSpool,
    captureGeneration: number,
  ): void {
    if (
      this.#spool !== spool ||
      !this.#captureEnabled ||
      event.contentChanges.length === 0 ||
      event.document.uri.scheme !== "file" ||
      event.document.uri.authority.length > 0 ||
      event.document.isUntitled
    ) {
      return;
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(
      event.document.uri,
    );
    if (
      workspaceFolder === undefined ||
      workspaceFolder.uri.scheme !== "file" ||
      workspaceFolder.uri.authority.length > 0
    ) {
      return;
    }

    const pending: PendingDocumentChange = {
      workspaceRoot: workspaceFolder.uri.fsPath,
      documentPath: event.document.uri.fsPath,
      scheme: event.document.uri.scheme,
      isUntitled: event.document.isUntitled,
      languageId: event.document.languageId,
      documentVersion: event.document.version,
      occurredAtMs: Date.now(),
      contentChanges: event.contentChanges.map((change) => ({
        rangeOffset: change.rangeOffset,
        rangeLength: change.rangeLength,
        text: change.text,
      })),
    };
    this.#documentChangeChain = this.#documentChangeChain
      .then(() =>
        this.#handleDocumentChange(pending, spool, captureGeneration),
      )
      .catch((error: unknown) => {
        this.#haltAfterSpoolError(spool, error);
      });
  }

  async #handleDocumentChange(
    event: PendingDocumentChange,
    spool: AtomicJsonlSpool,
    captureGeneration: number,
  ): Promise<void> {
    const relativePath = await resolveCanonicalWorkspaceRelativePath(
      event.workspaceRoot,
      event.documentPath,
    );
    if (
      !relativePath.ok ||
      captureGeneration !== this.#captureGeneration ||
      this.#spool !== spool ||
      !this.#captureEnabled ||
      !isSafeDocumentCandidate({
        scheme: event.scheme,
        isUntitled: event.isUntitled,
        languageId: event.languageId,
        relativePath: relativePath.path,
      })
    ) {
      return;
    }

    const safeEvent = buildEditEvent({
      sourceInstanceId: this.#sourceInstanceId,
      workspaceUri: vscode.Uri.file(relativePath.workspaceRoot).toString(true),
      relativePath: relativePath.path,
      languageId: event.languageId,
      documentVersion: event.documentVersion,
      occurredAtMs: event.occurredAtMs,
      observedAtMs: Date.now(),
      includeText: this.#settings.includeText,
      contentChanges: event.contentChanges,
    });
    spool.enqueue(safeEvent);
  }

  #haltAfterSpoolError(spool: AtomicJsonlSpool, error: unknown): void {
    if (this.#spool !== spool) {
      return;
    }
    this.#documentListener?.dispose();
    this.#documentListener = null;
    this.#captureEnabled = false;
    this.#spool = null;
    this.#setError(error);
    void spool.close().catch(() => undefined);
  }

  #setError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.#setRuntimeState({ kind: "error", detail: message });
  }

  #setRuntimeState(state: RuntimeState): void {
    this.#runtimeState = state;
    switch (state.kind) {
      case "disabled":
        this.#statusBar.text = "$(circle-slash) WhaleHall: off";
        this.#statusBar.tooltip =
          "Edit monitoring is disabled. Click for status.";
        this.#statusBar.backgroundColor = undefined;
        break;
      case "active":
        this.#statusBar.text = state.includeText
          ? "$(shield) WhaleHall: content"
          : "$(shield) WhaleHall: metadata";
        this.#statusBar.tooltip = state.includeText
          ? "Local edit monitoring is active and bounded inserted text is enabled."
          : "Local edit monitoring is active without editor text.";
        this.#statusBar.backgroundColor = undefined;
        break;
      case "untrusted":
      case "missingWorkspace":
      case "invalidConfiguration":
      case "error":
        this.#statusBar.text = "$(warning) WhaleHall: inactive";
        this.#statusBar.tooltip = this.#describeRuntimeState();
        this.#statusBar.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.warningBackground",
        );
        break;
    }
  }

  #describeRuntimeState(): string {
    const state = this.#runtimeState;
    switch (state.kind) {
      case "disabled":
        return "WhaleHall edit monitoring is disabled.";
      case "untrusted":
        return "WhaleHall edit monitoring is inactive because the workspace is not trusted.";
      case "missingWorkspace":
        return "WhaleHall edit monitoring requires an open local workspace.";
      case "invalidConfiguration":
        return `WhaleHall edit monitoring configuration is invalid: ${state.detail}.`;
      case "active":
        return state.includeText
          ? "WhaleHall edit monitoring is active. Bounded inserted text is included; deleted text is never collected."
          : "WhaleHall edit monitoring is active in metadata-only mode. Editor text is not collected.";
      case "error":
        return `WhaleHall edit monitoring stopped after a local spool error: ${state.detail}.`;
    }
  }
}

let activeController: MonitoringController | null = null;

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  activeController = await MonitoringController.create(context);
  context.subscriptions.push(activeController);
}

export async function deactivate(): Promise<void> {
  const controller = activeController;
  activeController = null;
  await controller?.shutdown();
}
