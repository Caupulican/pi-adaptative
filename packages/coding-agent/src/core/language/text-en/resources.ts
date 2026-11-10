/**
 * The English words of the resource commands and of the loaded-resources view: `/install-resources`, `/curate`, the bash
 * and compaction commands' host lines, the scope labels a listing groups by, the diagnostics it prints and the section
 * titles of the startup listing. A scope keeps its identifier (it decides which group an item lands in) and takes its
 * label from here.
 */

export const RESOURCES = {
	install: {
		usage: "Usage: /install-resources <dir> [--force]",
		missingDir: (dir: string) => `Source directory does not exist: ${dir}`,
		trustTitle: "Trust external source for installation?",
		trustDescription: (dir: string) =>
			`The directory "${dir}" contains extensions/resources to install. Extensions can execute arbitrary code on your machine. Do you trust it?`,
		trustAccept: "Trust this directory and proceed with installation.",
		trustReject: "Do not trust this directory. Abort.",
		aborted: "Installation aborted. Source directory was not trusted.",
		complete: (installed: number, skipped: number) =>
			`Installation complete: ${installed} resources installed, ${skipped} skipped.`,
	},
	curate: {
		archived: (name: string) => `Archived promoted skill '${name}'`,
		archiveFailed: (name: string) => `Could not archive '${name}' (not a promoted skill?)`,
		restored: (name: string) => `Restored skill '${name}'`,
		restoreFailed: (name: string) => `Could not restore '${name}'`,
		empty: "Curator: no stale or overlapping promoted skills. Nothing to propose.",
		header: "Skill curator proposals (nothing applied automatically):",
		archiveProposal: (name: string, reason: string) =>
			`  • archive '${name}' — ${reason}  →  /curate archive ${name}`,
		mergeProposal: (first: string, second: string, overlapPercent: number) =>
			`  • consider merging '${first}' + '${second}' (overlap ${overlapPercent}%)`,
	},
	bash: {
		failed: (error: string) => `Bash command failed: ${error}`,
		unknownError: "Unknown error",
	},
	compact: {
		nothing: "Nothing to compact (no messages yet)",
	},
	/** The label a listing gives each scope. The scope itself stays an identifier. */
	scope: {
		user: "user",
		project: "project",
		path: "path",
		temp: "temp",
	},
	diagnostics: {
		collision: (name: string) => `  "${name}" collision:`,
		skipped: "(skipped)",
	},
	loaded: {
		context: "Context",
		skills: "Skills",
		prompts: "Prompts",
		extensions: "Extensions",
		themes: "Themes",
		skillConflicts: "Skill conflicts",
		promptConflicts: "Prompt conflicts",
		extensionIssues: "Extension issues",
		themeConflicts: "Theme conflicts",
		/** An extension whose command name a built-in command already takes. */
		commandConflictSkipped: (name: string) =>
			`Extension command '/${name}' conflicts with built-in interactive command. Skipping in autocomplete.`,
		commandConflictAvailable: (name: string, invocationName: string) =>
			`Extension command '/${name}' conflicts with built-in interactive command. Available as '/${invocationName}'.`,
	},
};
