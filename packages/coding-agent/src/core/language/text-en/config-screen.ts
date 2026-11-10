/**
 * The configuration selector and the backup and restore screens: the resource groups, the type names, the
 * headings and every status line and error the backup and restore commands print to the owner.
 */

export const CONFIG_SCREEN = {
	resourceTypes: {
		extensions: "Extensions",
		skills: "Skills",
		prompts: "Prompts",
		themes: "Themes",
	},
	/** The scope word shown inside a group label; the scope itself stays the code's own value. */
	scope: { user: "user", project: "project", temporary: "temporary" },
	groups: {
		package: (source: string, scope: string) => `${source} (${scope})`,
		userAt: (directory: string) => `User (${directory})`,
		projectAt: (directory: string) => `Project (${directory})`,
		userDefault: "User (~/.pi/agent/)",
		projectDefault: "Project (.pi/)",
		userSettings: "User settings",
		projectSettings: "Project settings",
	},
	title: "Resource Configuration",
	filter: "Type to filter resources",
	empty: "No resources found",
	backup: {
		saved: (file: string) => `Configuration backup saved to ${file}`,
		usage: "Usage: /config-restore <file>",
		missing: (file: string) => `Backup file does not exist: ${file}`,
		parseFailed: (message: string) => `Failed to parse backup file: ${message}`,
		notObject: "Invalid backup file: must be a JSON object",
		confirmTitle: "Restore configuration?",
		confirmBody:
			"This will overwrite existing local profiles and settings with the backup values. Do you want to continue?",
		proceed: "Proceed with restoration.",
		abort: "Cancel and abort.",
		aborted: "Restore aborted.",
		restored: "Configuration restored successfully.",
		failed: (message: string) => `Configuration restore failed: ${message}; previous configuration restored`,
		failedWithRollback: (message: string, rollback: string) =>
			`Configuration restore failed: ${message}; rollback failed: ${rollback}`,
	},
	validation: {
		arrayOfStrings: (label: string) => `Invalid backup file: ${label} must be an array of strings`,
		profilesObject: "Invalid backup file: settings.resourceProfiles must be an object",
		malformedProfile: (name: string) => `Invalid backup file: malformed resource profile "${name}"`,
		profilesMustBeObject: "Invalid backup file: profiles must be an object",
		unsafeProfileFile: (filename: string) => `Invalid backup file: unsafe profile filename "${filename}"`,
		profileNotSerializable: (filename: string) => `Invalid backup file: profile "${filename}" is not serializable`,
		runtimeValidation: "restored configuration failed runtime validation",
	},
};
