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
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "autonomy", description: "Show or set autonomy mode (/autonomy full)" },
	{ name: "auto-learn", description: "Show Auto Learn/reflection status or run now (/auto-learn run)" },
	{ name: "model", description: "Select model (opens selector UI)" },
	{ name: "profiles", description: "Select a runtime profile for this session" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
	{ name: "import", description: "Import and resume a session from a JSONL file" },
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
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
	{ name: "curate", description: "Review/archive stale or overlapping reflection-promoted skills" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, and themes" },
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
