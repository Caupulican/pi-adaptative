/**
 * The English words of the slash command controller and the start-up checks: the reload notice and its refusals, the
 * owner-facing refusals and notices of the commands it routes, and the update and trust notices the terminal shows when
 * the session begins. Command names and their arguments stay exactly as the commands take them.
 */

export const COMMAND_CONTROLLER = {
	commands: {
		secretsNeedsTerminal: "/secrets requires an owner-controlled interactive terminal.",
		reloadWaitingForResponse: "Wait for the current response to finish before reloading.",
		reloadWaitingForCompaction: "Wait for compaction to finish before reloading.",
		reloading: "Reloading keybindings, extensions, skills, prompts, themes...",
		reloaded: "Reloaded keybindings, extensions, skills, prompts, themes",
		modelsJsonError: (error: string) => `models.json error: ${error}`,
		reloadFailed: (error: string) => `Reload failed: ${error}`,
		extensionRefreshFailed: (error: string) => `Extension refresh failed: ${error}`,
		goalContinueUsage: "Usage: /goal-continue [maxTurns 0=unbounded] [maxStallTurns 0-100] [maxMinutes 0-1440]",
		editGoalObjective: "Edit goal objective",
		selfCompactionRefused: (reason: string) => `Self-compaction: ${reason}.`,
		selfCompactionResumed: (chars: string) => `Self-compaction: compacting with the saved note (${chars} chars).`,
		selfCompactionAsked: "Self-compaction: asked the agent to write its note and compact.",
		selfCompactionFailed: (error: string) => `Self-compaction failed: ${error}`,
		newSessionNamed: (name: string) => `✓ New session started: ${name}`,
		newSession: "✓ New session started",
		createSessionFailed: "Failed to create session",
	},
	startup: {
		selfUpdated: (version: string) =>
			`Updated to ${version}. This session stays on the previous release until you start Pi again.`,
		updated: (version: string, command: string) => `Updated to v${version}. Use ${command} to view full changelog.`,
		trustWarning:
			"This project is not trusted. Project instructions (AGENTS.md/CLAUDE.md/GEMINI.md), .pi resources, and project packages are ignored. Use /trust to trust it.",
		updateAvailable: "Update Available",
		newVersion: (name: string, version: string) => `New version ${version} is available. Run ${name} update`,
		changelogLabel: "Changelog: ",
		openChangelog: "open changelog",
		packageUpdatesAvailable: "Package Updates Available",
		packageUpdates: (name: string) => `Package updates are available. Run ${name} update`,
		packagesLabel: "Packages:",
		tmuxExtendedKeys:
			"tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.",
		tmuxExtendedKeysFormat:
			"tmux extended-keys-format is xterm. Pi works best with csi-u. Add `set -g extended-keys-format csi-u` to ~/.tmux.conf and restart tmux.",
	},
};
