/**
 * The secret menu over Bitwarden: the action list, the credential shapes, the prompts of every flow and the
 * notices it prints. Nothing here is ever sent to a model.
 */

export const SECRETS_SCREEN = {
	title: "Secrets · Bitwarden",
	actions: {
		add: "Add or update credentials",
		activate: "Activate credentials for this project",
		bind: "Use an existing profile in this project",
		remove: "Remove a credential profile",
		reconnect: "Reconnect Bitwarden",
		lock: "Lock Pi credentials",
		close: "Close",
	},
	shapes: {
		userPassword: "Username and password",
		key: "API token or private key",
		dotenv: "Environment variables (.env format)",
	},
	/** A count of stored variables, agreeing with the number. */
	variableCount: (count: number) => (count === 1 ? "1 variable" : `${count} variables`),
	notices: {
		machineSetup:
			"Bitwarden is not connected. Set BWS_ACCESS_TOKEN or BW_SESSION in your environment yourself; Pi never asks for it.",
		failedSafely: "Credential operation failed safely without exposing private data.",
		keyFileMissing: "dropped key file was not found or is not a regular file",
		keyFileTooLarge: "dropped key file exceeds the 64 KiB value limit",
		reconnected: "Bitwarden reconnected from machine-owned credentials.",
		locked: "Pi credential access is locked for this session.",
		profileRequired: "Credential profile name is required.",
		noGitRemote: "This project has no portable Git remote, so its binding is local to this machine.",
	},
	prompts: {
		profile: "Credential profile",
		profilePlaceholder: "Example: deploy-prod",
		updateTitle: "Update credential profile",
		updateBody: (profile: string) =>
			`Replace the stored values for ${profile} while preserving its project bindings?`,
		description: "Description",
		descriptionPlaceholder: "Optional non-secret description",
		shape: "Credential shape",
		stored: (profile: string, variables: string) => `Stored and activated ${profile} (${variables}) in Bitwarden.`,
		usernameVariable: "Username variable",
		username: "Username",
		usernamePlaceholder: "Type the account username",
		passwordVariable: "Password variable",
		password: "Password",
		passwordPlaceholder: "Type the account password",
		keyVariable: "Key variable",
		privateValueTitle: (variable: string) => `Private value · ${variable}`,
		privateValueNotice: "Paste a token/key, or drag an absolute key-file path here · never sent to the model",
		environmentTitle: "Environment credentials",
		environmentNotice: "Private .env editor · paste one or more NAME=value entries · never sent to the model",
		activateTitle: "Activate credentials",
		activated: (profile: string, project: string, variables: string) =>
			`Activated ${profile} for ${project} (${variables}).`,
		bindTitle: "Use profile in this project",
		bound: (profile: string, project: string) => `Bound ${profile} to ${project}.`,
		removeTitle: "Remove credential profile",
		removeBody: (profile: string) => `Move ${profile} to Bitwarden trash and clear its active environment?`,
		removed: (profile: string, variables: string) => `Removed ${profile} (${variables}).`,
	},
};
