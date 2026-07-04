/**
 * Startup notices and update/telemetry checks extracted from interactive-mode.
 *
 * These render the "What's New" changelog notice and the untrusted-project
 * warning, probe for package/tmux configuration issues, surface update
 * notifications, and report anonymous install telemetry. They read
 * session/settings state and render into the chat container through a narrow
 * `StartupChecksHost` seam (`startupNoticesShown` is threaded via get/set);
 * interactive-mode keeps thin delegating wrappers.
 */

import { spawn } from "node:child_process";
import type { SessionManager } from "@caupulican/pi-agent-core/node";
import type { Container, MarkdownTheme, TUI } from "@caupulican/pi-tui";
import { getCapabilities, hyperlink, Markdown, Spacer, Text } from "@caupulican/pi-tui";
import { APP_NAME, getAgentDir, VERSION } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import { DefaultPackageManager } from "../../core/package-manager.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { isInstallTelemetryEnabled } from "../../core/telemetry.ts";
import { hasProjectTrustInputs } from "../../core/trust-manager.ts";
import { getChangelogPath, getNewEntries, parseChangelog } from "../../utils/changelog.ts";
import { getPiUserAgent } from "../../utils/pi-user-agent.ts";
import type { LatestPiRelease } from "../../utils/version-check.ts";
import { DynamicBorder } from "./components/dynamic-border.ts";
import { theme } from "./theme/theme.ts";

export interface StartupChecksHost {
	readonly sessionManager: Pick<SessionManager, "getCwd">;
	readonly settingsManager: SettingsManager;
	readonly session: Pick<AgentSession, "state">;
	readonly chatContainer: Container;
	readonly ui: Pick<TUI, "requestRender">;
	readonly version: string;
	readonly changelogMarkdown: string | undefined;
	startupNoticesShown: boolean;
	getMarkdownThemeWithSettings(): MarkdownTheme;
}

export async function checkForPackageUpdates(host: StartupChecksHost): Promise<string[]> {
	if (process.env.PI_OFFLINE) {
		return [];
	}

	try {
		const packageManager = new DefaultPackageManager({
			cwd: host.sessionManager.getCwd(),
			agentDir: getAgentDir(),
			settingsManager: host.settingsManager,
		});
		const updates = await packageManager.checkForAvailableUpdates();
		return updates.map((update) => update.displayName);
	} catch {
		return [];
	}
}

export async function checkTmuxKeyboardSetup(): Promise<string | undefined> {
	if (!process.env.TMUX) return undefined;

	const runTmuxShow = (option: string): Promise<string | undefined> => {
		return new Promise((resolve) => {
			const proc = spawn("tmux", ["show", "-gv", option], {
				stdio: ["ignore", "pipe", "ignore"],
			});
			let stdout = "";
			const timer = setTimeout(() => {
				proc.kill();
				resolve(undefined);
			}, 2000);

			proc.stdout?.on("data", (data) => {
				stdout += data.toString();
			});
			proc.on("error", () => {
				clearTimeout(timer);
				resolve(undefined);
			});
			proc.on("close", (code) => {
				clearTimeout(timer);
				resolve(code === 0 ? stdout.trim() : undefined);
			});
		});
	};

	const [extendedKeys, extendedKeysFormat] = await Promise.all([
		runTmuxShow("extended-keys"),
		runTmuxShow("extended-keys-format"),
	]);

	// If we couldn't query tmux (timeout, sandbox, etc.), don't warn
	if (extendedKeys === undefined) return undefined;

	if (extendedKeys !== "on" && extendedKeys !== "always") {
		return "tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.";
	}

	if (extendedKeysFormat === "xterm") {
		return "tmux extended-keys-format is xterm. Pi works best with csi-u. Add `set -g extended-keys-format csi-u` to ~/.tmux.conf and restart tmux.";
	}

	return undefined;
}

/**
 * Get changelog entries to display on startup.
 * Only shows new entries since last seen version, skips for resumed sessions.
 */
export function getChangelogForDisplay(host: StartupChecksHost): string | undefined {
	// Skip changelog for resumed/continued sessions (already have messages)
	if (host.session.state.messages.length > 0) {
		return undefined;
	}

	const lastVersion = host.settingsManager.getLastChangelogVersion();
	const changelogPath = getChangelogPath();
	const entries = parseChangelog(changelogPath);

	if (!lastVersion) {
		// Fresh install - record the version, send telemetry, don't show changelog
		host.settingsManager.setLastChangelogVersion(VERSION);
		reportInstallTelemetry(host, VERSION);
		return undefined;
	}

	const newEntries = getNewEntries(entries, lastVersion);
	if (newEntries.length > 0) {
		host.settingsManager.setLastChangelogVersion(VERSION);
		reportInstallTelemetry(host, VERSION);
		return newEntries.map((e) => e.content).join("\n\n");
	}

	return undefined;
}

function reportInstallTelemetry(host: StartupChecksHost, version: string): void {
	if (process.env.PI_OFFLINE) {
		return;
	}

	if (!isInstallTelemetryEnabled(host.settingsManager)) {
		return;
	}

	void fetch(`https://pi.dev/api/report-install?version=${encodeURIComponent(version)}`, {
		headers: {
			"User-Agent": getPiUserAgent(version),
		},
		signal: AbortSignal.timeout(5000),
	})
		.then(() => undefined)
		.catch(() => undefined);
}

export function showStartupNoticesIfNeeded(host: StartupChecksHost): void {
	if (host.startupNoticesShown) {
		return;
	}
	host.startupNoticesShown = true;

	if (!host.changelogMarkdown) {
		return;
	}

	if (host.chatContainer.children.length > 0) {
		host.chatContainer.addChild(new Spacer(1));
	}
	host.chatContainer.addChild(new DynamicBorder());
	if (host.settingsManager.getCollapseChangelog()) {
		const versionMatch = host.changelogMarkdown.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/);
		const latestVersion = versionMatch ? versionMatch[1] : host.version;
		const condensedText = `Updated to v${latestVersion}. Use ${theme.bold("/changelog")} to view full changelog.`;
		host.chatContainer.addChild(new Text(condensedText, 1, 0));
	} else {
		host.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
		host.chatContainer.addChild(new Spacer(1));
		host.chatContainer.addChild(
			new Markdown(host.changelogMarkdown.trim(), 1, 0, host.getMarkdownThemeWithSettings()),
		);
		host.chatContainer.addChild(new Spacer(1));
	}
	host.chatContainer.addChild(new DynamicBorder());
}

export function renderProjectTrustWarningIfNeeded(host: StartupChecksHost): void {
	if (host.settingsManager.isProjectTrusted() || !hasProjectTrustInputs(host.sessionManager.getCwd())) {
		return;
	}

	if (host.chatContainer.children.length > 0) {
		host.chatContainer.addChild(new Spacer(1));
	}
	host.chatContainer.addChild(
		new Text(
			theme.fg(
				"warning",
				"This project is not trusted. Project instructions (AGENTS.md/CLAUDE.md/GEMINI.md), .pi resources, and project packages are ignored. Use /trust to save a trust decision, then restart pi.",
			),
			1,
			0,
		),
	);
}

export function showNewVersionNotification(host: StartupChecksHost, release: LatestPiRelease): void {
	const action = theme.fg("accent", `${APP_NAME} update`);
	const updateInstruction = theme.fg("muted", `New version ${release.version} is available. Run `) + action;
	const changelogUrl = "https://pi.dev/changelog";
	const changelogLink = getCapabilities().hyperlinks
		? hyperlink(theme.fg("accent", "open changelog"), changelogUrl)
		: theme.fg("accent", changelogUrl);
	const changelogLine = theme.fg("muted", "Changelog: ") + changelogLink;
	const note = release.note?.trim();

	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
	host.chatContainer.addChild(
		new Text(`${theme.bold(theme.fg("warning", "Update Available"))}\n${updateInstruction}`, 1, 0),
	);
	if (note) {
		host.chatContainer.addChild(new Spacer(1));
		host.chatContainer.addChild(
			new Markdown(note, 1, 0, host.getMarkdownThemeWithSettings(), {
				color: (text) => theme.fg("muted", text),
			}),
		);
		host.chatContainer.addChild(new Spacer(1));
	}
	host.chatContainer.addChild(new Text(changelogLine, 1, 0));
	host.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
	host.ui.requestRender();
}

export function showPackageUpdateNotification(host: StartupChecksHost, packages: string[]): void {
	const action = theme.fg("accent", `${APP_NAME} update`);
	const updateInstruction = theme.fg("muted", "Package updates are available. Run ") + action;
	const packageLines = packages.map((pkg) => `- ${pkg}`).join("\n");

	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
	host.chatContainer.addChild(
		new Text(
			`${theme.bold(theme.fg("warning", "Package Updates Available"))}\n${updateInstruction}\n${theme.fg("muted", "Packages:")}\n${packageLines}`,
			1,
			0,
		),
	);
	host.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
	host.ui.requestRender();
}
