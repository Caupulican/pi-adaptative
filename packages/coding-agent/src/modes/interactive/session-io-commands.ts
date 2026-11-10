/**
 * Session import/export/share/copy/name command bodies extracted from
 * interactive-mode.
 *
 * These drive session serialization (JSONL/HTML export, JSONL import, secret
 * gist share), clipboard copy of the last agent message, and session naming
 * through narrow per-command host seams. `getPathCommandArgument` stays host-side
 * (pure parser, tested directly and shared by export/import); interactive-mode
 * keeps thin delegating wrappers, so the `/import` behaviour test keeps
 * exercising it unchanged.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { EditorComponent, TUI } from "@caupulican/pi-tui";
import { Spacer, Text } from "@caupulican/pi-tui";
import { getAgentDir, getShareViewerUrl } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { SessionImportFileNotFoundError } from "../../core/agent-session-runtime.ts";
import { interfaceText } from "../../core/language/interface-text.ts";
import { MissingSessionCwdError } from "../../core/session-cwd.ts";
import type { SessionManager } from "../../kernel/node.ts";
import { theme } from "../../presentation/theme-model.ts";
import { spawnProcess, spawnProcessSync, waitForChildProcessWithTermination } from "../../utils/child-process.ts";
import { copyToClipboard } from "../../utils/clipboard.ts";
import { acquireWorkRun } from "../../utils/work-directory.ts";
import { BorderedLoader } from "./components/bordered-loader.ts";
import type { EditorOverlayHost } from "./editor-overlay-host.ts";
import type { ExtensionUiHost } from "./extension-ui-host.ts";
import { handleNonFatalSessionReplacementError } from "./session-replacement-errors.ts";

type PathCommand = "/export" | "/import";

export interface ExportCommandHost {
	readonly session: Pick<AgentSession, "exportToJsonl" | "exportToHtml">;
	getPathCommandArgument(text: string, command: PathCommand): string | undefined;
	showStatus(message: string): void;
	showError(message: string): void;
}

export interface ImportCommandHost {
	getPathCommandArgument(text: string, command: PathCommand): string | undefined;
	showError(message: string): void;
	showStatus(message: string): void;
	readonly extensionUiHost: Pick<ExtensionUiHost, "showExtensionConfirm">;
	loadingAnimation: { stop: () => void } | undefined;
	readonly statusContainer: { clear: () => void };
	readonly runtimeHost: Pick<AgentSessionRuntime, "importFromJsonl">;
	renderCurrentSessionState(): void;
	promptForMissingSessionCwd(error: MissingSessionCwdError): Promise<string | undefined>;
	handleFatalRuntimeError(prefix: string, error: unknown): Promise<never>;
}

export interface ShareCommandHost {
	showError(message: string): void;
	showStatus(message: string): void;
	readonly session: Pick<AgentSession, "exportToHtml">;
	readonly ui: TUI;
	readonly overlayHost: EditorOverlayHost;
	readonly editor: EditorComponent;
}

export interface CopyCommandHost {
	readonly session: Pick<AgentSession, "getLastAssistantText">;
	showError(message: string): void;
	showStatus(message: string): void;
	/**
	 * Text for whatever selection currently takes precedence over "last assistant message" (P1h/P1k)
	 * -- e.g. the highlighted entry while the /tree selector is open. Return undefined (not called,
	 * or no selection has copyable text) to fall back to the last assistant message.
	 */
	getSelectionText?(): string | undefined;
}

export interface NameCommandHost {
	readonly sessionManager: Pick<SessionManager, "getSessionName">;
	readonly chatContainer: { addChild: (child: Text | Spacer) => void };
	showWarning(message: string): void;
	readonly session: Pick<AgentSession, "setSessionName">;
	readonly ui: { requestRender: () => void };
}

export async function handleExportCommand(host: ExportCommandHost, text: string): Promise<void> {
	const words = interfaceText().sessions.io;
	const outputPath = host.getPathCommandArgument(text, "/export");

	try {
		if (outputPath?.endsWith(".jsonl")) {
			const filePath = host.session.exportToJsonl(outputPath);
			host.showStatus(words.exported(filePath));
		} else {
			const filePath = await host.session.exportToHtml(outputPath);
			host.showStatus(words.exported(filePath));
		}
	} catch (error: unknown) {
		host.showError(words.exportFailed(error instanceof Error ? error.message : words.unknownError));
	}
}

export async function handleImportCommand(host: ImportCommandHost, text: string): Promise<void> {
	const words = interfaceText().sessions.io;
	const inputPath = host.getPathCommandArgument(text, "/import");
	if (!inputPath) {
		host.showError(words.importUsage);
		return;
	}

	const confirmed = await host.extensionUiHost.showExtensionConfirm(
		words.importTitle,
		words.importQuestion(inputPath),
	);
	if (!confirmed) {
		host.showStatus(words.importCancelled);
		return;
	}

	try {
		if (host.loadingAnimation) {
			host.loadingAnimation.stop();
			host.loadingAnimation = undefined;
		}
		host.statusContainer.clear();
		const result = await host.runtimeHost.importFromJsonl(inputPath);
		if (result.cancelled) {
			host.showStatus(words.importCancelled);
			return;
		}
		host.renderCurrentSessionState();
		host.showStatus(words.imported(inputPath));
	} catch (error: unknown) {
		if (handleNonFatalSessionReplacementError(host, error)) return;
		if (error instanceof MissingSessionCwdError) {
			const selectedCwd = await host.promptForMissingSessionCwd(error);
			if (!selectedCwd) {
				host.showStatus(words.importCancelled);
				return;
			}
			try {
				const result = await host.runtimeHost.importFromJsonl(inputPath, selectedCwd);
				if (result.cancelled) {
					host.showStatus(words.importCancelled);
					return;
				}
				host.renderCurrentSessionState();
				host.showStatus(words.imported(inputPath));
				return;
			} catch (retryError: unknown) {
				if (handleNonFatalSessionReplacementError(host, retryError)) return;
				await host.handleFatalRuntimeError(words.importFailed, retryError);
			}
		}
		if (error instanceof SessionImportFileNotFoundError) {
			host.showError(`${words.importFailed}: ${error.message}`);
			return;
		}
		await host.handleFatalRuntimeError(words.importFailed, error);
	}
}

const GH_AUTH_TIMEOUT_MS = 15_000;
const GIST_CREATE_TIMEOUT_MS = 120_000;
const GIST_KILL_GRACE_MS = 500;
const MAX_GIST_COMMAND_OUTPUT = 16 * 1024;

export async function handleShareCommand(host: ShareCommandHost): Promise<void> {
	const words = interfaceText().sessions.io;
	const authResult = spawnProcessSync("gh", ["auth", "status"], {
		encoding: "utf8",
		maxBuffer: 1024 * 1024,
		timeout: GH_AUTH_TIMEOUT_MS,
		windowsHide: true,
	});
	if (authResult.error) {
		const code = (authResult.error as NodeJS.ErrnoException).code;
		host.showError(code === "ENOENT" ? words.ghMissing : words.ghAuthCheckFailed(authResult.error.message));
		return;
	}
	if (authResult.status !== 0) {
		host.showError(words.ghNotLoggedIn);
		return;
	}

	const workRun = acquireWorkRun({ agentDir: getAgentDir(), category: "sharing", tenant: "gist" });
	const tempDir = workRun.path;
	const tempFile = path.join(tempDir, "session.html");
	const cleanupWorkRun = () => {
		workRun.release();
		fs.rmSync(tempDir, { recursive: true, force: true });
	};
	try {
		await host.session.exportToHtml(tempFile);
	} catch (error: unknown) {
		cleanupWorkRun();
		host.showError(words.exportFailed(error instanceof Error ? error.message : words.unknownError));
		return;
	}

	const loader = new BorderedLoader(host.ui, theme, words.creatingGist);
	let restored = false;
	let aborted = false;
	let superseded = false;
	const restoreEditor = () => {
		if (restored) return;
		restored = true;
		loader.dispose();
		if (!superseded) host.overlayHost.swap(host.editor, { render: "none" });
	};
	loader.onAbort = () => {
		aborted = true;
		restoreEditor();
		if (!superseded) host.showStatus(words.shareCancelled);
	};
	host.overlayHost.swap(loader, {
		onUnmount: () => {
			if (restored) return;
			superseded = true;
			loader.cancel();
		},
	});

	try {
		let stdout = "";
		let stderr = "";
		const child = spawnProcess("gh", ["gist", "create", "--public=false", tempFile], {
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		child.stdout?.on("data", (data: Buffer) => {
			stdout = (stdout + data.toString("utf8")).slice(-MAX_GIST_COMMAND_OUTPUT);
		});
		child.stderr?.on("data", (data: Buffer) => {
			stderr = (stderr + data.toString("utf8")).slice(-MAX_GIST_COMMAND_OUTPUT);
		});
		const terminal = await waitForChildProcessWithTermination(child, {
			signal: loader.signal,
			timeoutMs: GIST_CREATE_TIMEOUT_MS,
			killGraceMs: GIST_KILL_GRACE_MS,
		});

		if (terminal.reason === "aborted" || aborted) return;
		restoreEditor();
		if (terminal.reason === "timeout") {
			host.showError(words.gistTimedOut);
			return;
		}
		if (terminal.code !== 0) {
			host.showError(words.gistFailed(stderr.trim()));
			return;
		}

		const gistUrl = stdout.trim();
		const gistId = gistUrl.split("/").pop();
		if (!gistId) {
			host.showError(words.gistIdUnparsed);
			return;
		}

		const previewUrl = getShareViewerUrl(gistId);
		host.showStatus(words.shareUrls({ url: previewUrl, gistUrl }));
	} catch (error: unknown) {
		if (!aborted) {
			host.showError(words.gistCreateFailed(error instanceof Error ? error.message : words.unknownError));
		}
	} finally {
		restoreEditor();
		cleanupWorkRun();
	}
}

export async function handleCopyCommand(host: CopyCommandHost): Promise<void> {
	const words = interfaceText().sessions.io;
	const selectionText = host.getSelectionText?.();
	const text = selectionText ?? host.session.getLastAssistantText();
	if (!text) {
		host.showError(words.nothingToCopy);
		return;
	}

	try {
		await copyToClipboard(text);
		host.showStatus(selectionText !== undefined ? words.copiedSelection : words.copiedLast);
	} catch (error) {
		host.showError(error instanceof Error ? error.message : String(error));
	}
}

export function handleNameCommand(host: NameCommandHost, text: string): void {
	const words = interfaceText().sessions.io;
	const name = text.replace(/^\/name\s*/, "").trim();
	if (!name) {
		const currentName = host.sessionManager.getSessionName();
		if (currentName) {
			host.chatContainer.addChild(new Spacer(1));
			host.chatContainer.addChild(new Text(theme.fg("dim", words.sessionName(currentName)), 1, 0));
		} else {
			host.showWarning(words.nameUsage);
		}
		host.ui.requestRender();
		return;
	}

	host.session.setSessionName(name);
	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new Text(theme.fg("dim", words.sessionNameSet(name)), 1, 0));
	host.ui.requestRender();
}
