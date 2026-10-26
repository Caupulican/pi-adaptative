import { APP_NAME } from "../config.ts";
import type { SourceInfo } from "./source-info.ts";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
	/** Safe to execute locally while a foreground submission holds the session. Others require idle. */
	duringWork?: "local";
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "secrets", description: "Store and activate project credentials with Bitwarden" },
	{ name: "autonomy", description: "Autonomy mode, diagnostics, research, fitness (/autonomy status)" },
	{ name: "verify", description: "Verification obligations: /verify [list|show <id>|dismiss <id|all> [note]]" },
	{
		name: "memory",
		description: "Managed memory files: /memory drift · history · accept <target> · restore <target>",
	},
	{ name: "edge", description: "The edge: /edge [list] · allow <class> [note] · revoke <class>" },
	{
		name: "load",
		description: "Machine-wide provider load: in-flight requests, recorded limits, provider windows, emergency stop",
	},
	{
		name: "estop",
		description: "Emergency stop for new worker/background work on this machine: /estop [status|on [reason]|off]",
	},
	{
		name: "models",
		description: "Local model lifecycle: /models [list|suggest|add <ref>|remove <ref> confirm|stop]",
	},
	{
		name: "fitness",
		description: "Pick and probe a model for local/heavy-lifter roles, then assign it (/fitness [model] [trials])",
	},
	{ name: "context", description: "Context composition dashboard: what rides on every request", duringWork: "local" },
	{ name: "toolhealth", description: "Show tool repair diagnostics and learned standing rules", duringWork: "local" },
	{ name: "toolprobe", description: "Probe native/text tool-call support (/toolprobe [provider/model])" },
	{
		name: "toolrule-remove",
		description: "Remove a learned tool repair standing rule (/toolrule-remove <model> <mode>)",
	},
	{
		name: "toolprotocol-reset",
		description: "Reset text tool protocol calibration for a model (/toolprotocol-reset <provider/model>)",
	},
	{ name: "auto-learn", description: "Show Auto Learn/reflection status or run now (/auto-learn run)" },
	{
		name: "goal",
		description: "Goal lifecycle: view, edit, pause, resume, complete, clear, or replace (/goal to inspect)",
	},
	{
		name: "goal-continue",
		description: "Continue the current goal loop explicitly (/goal-continue [turns] [stalls])",
	},
	{
		name: "task",
		description: "Manage native session task steps (/task to list; /task add <text>)",
	},
	{
		name: "steps",
		description: "Alias for /task",
	},
	{
		name: "chat",
		duringWork: "local",
		description:
			"Switch live chat view between Brain (root), a persistent bot, or a team (/chat [root|<bot>|team:<id>])",
	},
	{
		name: "bot",
		duringWork: "local",
		description:
			"Manage and message persistent bots directly (/bot [list|new <id> [--write] [model] [role]|open <id>|msg <id> <text>|stop <id>|retire <id>])",
	},
	{
		name: "bots",
		duringWork: "local",
		description: "Open live Bot & Team chat switcher (/bots or /bot)",
	},
	{
		name: "team",
		duringWork: "local",
		description:
			"Manage and message multi-bot teams (/team [list|create <id> <bots> [desc]|members <id> <bots>|open <id>|msg <id> <text>|delete <id>])",
	},
	{
		name: "teams",
		duringWork: "local",
		description: "Alias for /team",
	},
	{
		name: "verification",
		duringWork: "local",
		description:
			"List open verification findings, or waive them with a reason when only you can answer them (/verification [list|waive <id|all> <reason>])",
	},
	{ name: "model", description: "Select model (opens selector UI)" },
	{ name: "thinking", description: "Select thinking level (/thinking [level])" },
	{ name: "fast", description: "Select provider processing tier (/fast [on|off|priority|ultrafast|status])" },
	{ name: "profiles", description: "Select a runtime profile for this session" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
	{ name: "import", description: "Import and resume a session from a JSONL file" },
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard", duringWork: "local" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats", duringWork: "local" },
	{ name: "cost", description: "Show session cost breakdown", duringWork: "local" },
	{
		name: "usage",
		duringWork: "local",
		description:
			"Usage and limits: session, today, machine and each signed-in account (/usage reset redeems an earned reset)",
	},
	{ name: "changelog", description: "Show changelog entries", duringWork: "local" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts", duringWork: "local" },
	{ name: "fork", description: "Create a new fork from a previous user message (optional name: /fork <name>)" },
	{
		name: "clone",
		description: "Duplicate the current session at the current position (optional name: /clone <name>)",
	},
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "trust", description: "Trust or untrust this project folder" },
	{ name: "login", description: "Configure provider authentication" },
	{ name: "logout", description: "Remove provider authentication" },
	{ name: "new", description: "Start a new session (optional name: /new <name>)" },
	{ name: "compact", description: "Manually compact the session context" },
	{
		name: "self-compact-info",
		duringWork: "local",
		description: "Show self-compaction usage, lines, phase, cycles, prompts and any saved note (no model turn)",
	},
	{
		name: "self-compact-now",
		description: "Compact now: reuse a saved self-compaction note, or ask the agent to write one",
	},
	{ name: "curate", description: "Review/archive stale or overlapping reflection-promoted skills" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, and themes" },
	{ name: "exit", description: `Quit ${APP_NAME}` },
	{
		name: "install-resources",
		description:
			"Copy resources from a trusted directory to user local settings (/install-resources <dir> [--force])",
	},
	{
		name: "config-backup",
		description: "Backup profiles and resource settings to a JSON file (/config-backup [file])",
	},
	{
		name: "config-restore",
		description: "Restore profiles and resource settings from a JSON file (/config-restore <file>)",
	},
	{ name: "quit", description: `Quit ${APP_NAME}` },
];
