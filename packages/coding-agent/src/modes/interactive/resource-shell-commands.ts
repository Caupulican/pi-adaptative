/**
 * Resource-install and shell/compaction command bodies extracted from
 * interactive-mode.
 *
 * `/install-resources` copies a trusted external resource tree into the agent
 * dir; `/curate` proposes/applies skill-curation actions; `!`/`!!` bash runs a
 * shell command (rendering a BashExecutionComponent, deferred while streaming);
 * `/compact` triggers manual compaction. Each takes a narrow host seam;
 * `copyResourcesRecursively` stays host-side (referenced directly by the
 * install-resources test), so interactive-mode keeps thin delegating wrappers.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionManager, TruncationResult } from "@caupulican/pi-agent-core/node";
import type { Component, Container, Loader, TUI } from "@caupulican/pi-tui";
import { getAgentDir } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { BashExecutionComponent } from "./components/bash-execution.ts";
import { SelectSubmenu } from "./components/settings-selector.ts";

export interface InstallResourcesHost {
	readonly settingsManager: Pick<
		SettingsManager,
		"canonicalizePath" | "getTrustedResourceRoots" | "addTrustedResourceRoot"
	>;
	showError(message: string): void;
	showStatus(message: string): void;
	showSelector(create: (done: () => void) => { component: Component; focus: Component }): void;
	handleReloadCommand(): Promise<void>;
	copyResourcesRecursively(
		src: string,
		dest: string,
		force: boolean,
		stats: { installed: string[]; skipped: string[] },
	): void;
}

export interface CurateCommandHost {
	readonly session: Pick<AgentSession, "archivePromotedSkill" | "restorePromotedSkill" | "proposeSkillCuration">;
	showStatus(message: string): void;
}

export interface BashCommandHost {
	readonly session: Pick<AgentSession, "extensionRunner" | "isStreaming" | "recordBashResult" | "executeBash">;
	readonly sessionManager: Pick<SessionManager, "getCwd">;
	readonly ui: TUI;
	readonly chatContainer: Container;
	readonly pendingMessagesContainer: Container;
	readonly pendingBashComponents: BashExecutionComponent[];
	bashComponent: BashExecutionComponent | undefined;
	showError(message: string): void;
}

export interface CompactCommandHost {
	readonly sessionManager: Pick<SessionManager, "getEntries">;
	showWarning(message: string): void;
	loadingAnimation: Loader | undefined;
	readonly statusContainer: { clear: () => void };
	readonly session: Pick<AgentSession, "compact">;
}

export async function handleInstallResourcesCommand(host: InstallResourcesHost, argsString: string): Promise<void> {
	try {
		const tokens = argsString.split(/\s+/).filter(Boolean);
		let force = false;
		let dir = "";
		for (const t of tokens) {
			if (t === "--force") {
				force = true;
			} else {
				dir = t;
			}
		}

		if (!dir) {
			host.showError("Usage: /install-resources <dir> [--force]");
			return;
		}

		const canonical = host.settingsManager.canonicalizePath(dir);
		if (!canonical || !fs.existsSync(canonical)) {
			host.showError(`Source directory does not exist: ${dir}`);
			return;
		}

		const trustedRoots = host.settingsManager.getTrustedResourceRoots();
		const trusted = trustedRoots.includes(canonical);

		if (!trusted) {
			const trust = await new Promise<boolean>((resolve) => {
				host.showSelector((done) => {
					const submenu = new SelectSubmenu(
						"Trust external source for installation?",
						`The directory "${canonical}" contains extensions/resources to install. Extensions can execute arbitrary code on your machine. Do you trust it?`,
						[
							{
								value: "yes",
								label: "Yes",
								description: "Trust this directory and proceed with installation.",
							},
							{ value: "no", label: "No", description: "Do not trust this directory. Abort." },
						],
						"no",
						(value) => {
							done();
							resolve(value === "yes");
						},
						() => {
							done();
							resolve(false);
						},
					);
					return { component: submenu, focus: submenu.getSelectList() };
				});
			});

			if (!trust) {
				host.showStatus("Installation aborted. Source directory was not trusted.");
				return;
			}

			host.settingsManager.addTrustedResourceRoot(canonical, "global");
		}

		const subdirs = ["skills", "extensions", "prompts", "themes", "profiles", "agents"];
		const stats = { installed: [] as string[], skipped: [] as string[] };
		const userAgentDir = getAgentDir();

		for (const sub of subdirs) {
			const srcSub = path.join(canonical, sub);
			const destSub = path.join(userAgentDir, sub);
			if (fs.existsSync(srcSub)) {
				host.copyResourcesRecursively(srcSub, destSub, force, stats);
			}
		}

		const installedCount = stats.installed.length;
		const skippedCount = stats.skipped.length;
		host.showStatus(`Installation complete: ${installedCount} resources installed, ${skippedCount} skipped.`);

		await host.handleReloadCommand();
	} catch (error) {
		host.showError(error instanceof Error ? error.message : String(error));
	}
}

/**
 * `/curate` — skill curator (#32). With no args, lists reflection-promoted skills proposed for
 * archival (stale/unused) and pairs proposed for consolidation (overlapping). PROPOSE-ONLY: the user
 * applies actions explicitly via `/curate archive <name>` / `/curate restore <name>`. Never touches
 * hand-authored skills; archival is restorable.
 */
export function handleCurateCommand(host: CurateCommandHost, args: string): void {
	const [sub, name] = args.split(/\s+/, 2);
	if (sub === "archive" && name) {
		host.showStatus(
			host.session.archivePromotedSkill(name)
				? `Archived promoted skill '${name}'`
				: `Could not archive '${name}' (not a promoted skill?)`,
		);
		return;
	}
	if (sub === "restore" && name) {
		host.showStatus(
			host.session.restorePromotedSkill(name) ? `Restored skill '${name}'` : `Could not restore '${name}'`,
		);
		return;
	}
	const proposals = host.session.proposeSkillCuration();
	if (proposals.archive.length === 0 && proposals.consolidate.length === 0) {
		host.showStatus("Curator: no stale or overlapping promoted skills. Nothing to propose.");
		return;
	}
	const lines: string[] = ["Skill curator proposals (nothing applied automatically):"];
	for (const a of proposals.archive) {
		lines.push(`  • archive '${a.name}' — ${a.reason}  →  /curate archive ${a.name}`);
	}
	for (const c of proposals.consolidate) {
		lines.push(`  • consider merging '${c.names[0]}' + '${c.names[1]}' (overlap ${(c.overlap * 100) | 0}%)`);
	}
	host.showStatus(lines.join("\n"));
}

export async function handleBashCommand(
	host: BashCommandHost,
	command: string,
	excludeFromContext = false,
): Promise<void> {
	const extensionRunner = host.session.extensionRunner;

	// Emit user_bash event to let extensions intercept
	const eventResult = await extensionRunner.emitUserBash({
		type: "user_bash",
		command,
		excludeFromContext,
		cwd: host.sessionManager.getCwd(),
	});

	// If extension returned a full result, use it directly
	if (eventResult?.result) {
		const result = eventResult.result;

		// Create UI component for display
		host.bashComponent = new BashExecutionComponent(command, host.ui, excludeFromContext);
		if (host.session.isStreaming) {
			host.pendingMessagesContainer.addChild(host.bashComponent);
			host.pendingBashComponents.push(host.bashComponent);
		} else {
			host.chatContainer.addChild(host.bashComponent);
		}

		// Show output and complete
		if (result.output) {
			host.bashComponent.appendOutput(result.output);
		}
		host.bashComponent.setComplete(
			result.exitCode,
			result.cancelled,
			result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
			result.fullOutputPath,
		);

		// Record the result in session
		host.session.recordBashResult(command, result, { excludeFromContext });
		host.bashComponent = undefined;
		host.ui.requestRender();
		return;
	}

	// Normal execution path (possibly with custom operations)
	const isDeferred = host.session.isStreaming;
	host.bashComponent = new BashExecutionComponent(command, host.ui, excludeFromContext);

	if (isDeferred) {
		// Show in pending area when agent is streaming
		host.pendingMessagesContainer.addChild(host.bashComponent);
		host.pendingBashComponents.push(host.bashComponent);
	} else {
		// Show in chat immediately when agent is idle
		host.chatContainer.addChild(host.bashComponent);
	}
	host.ui.requestRender();

	try {
		const result = await host.session.executeBash(
			command,
			(chunk) => {
				if (host.bashComponent) {
					host.bashComponent.appendOutput(chunk);
					host.ui.requestRender();
				}
			},
			{ excludeFromContext, operations: eventResult?.operations },
		);

		if (host.bashComponent) {
			host.bashComponent.setComplete(
				result.exitCode,
				result.cancelled,
				result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
				result.fullOutputPath,
			);
		}
	} catch (error) {
		if (host.bashComponent) {
			host.bashComponent.setComplete(undefined, false);
		}
		host.showError(`Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`);
	}

	host.bashComponent = undefined;
	host.ui.requestRender();
}

export async function handleCompactCommand(host: CompactCommandHost, customInstructions?: string): Promise<void> {
	const entries = host.sessionManager.getEntries();
	const messageCount = entries.filter((e) => e.type === "message").length;

	if (messageCount < 2) {
		host.showWarning("Nothing to compact (no messages yet)");
		return;
	}

	if (host.loadingAnimation) {
		host.loadingAnimation.stop();
		host.loadingAnimation = undefined;
	}
	host.statusContainer.clear();

	try {
		await host.session.compact(customInstructions);
	} catch {
		// Ignore, will be emitted as an event
	}
}
