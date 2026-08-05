import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ExtensionUIContext } from "../../core/extensions/types.ts";
import {
	type CredentialManager,
	CredentialManagerError,
	type CredentialProfileSummary,
	CredentialStorageError,
} from "../../core/secrets/credential-manager.ts";
import {
	formatDotenvVariables,
	MAX_DOTENV_VALUE_BYTES,
	parseDotenvDocument,
	SecretDotenvError,
} from "../../core/secrets/secret-dotenv.ts";
import { ExtensionEditorComponent } from "./components/extension-editor.ts";

const ADD_ACTION = "Add or update credentials";
const ACTIVATE_ACTION = "Activate credentials for this project";
const BIND_ACTION = "Use an existing profile in this project";
const REMOVE_ACTION = "Remove a credential profile";
const RECONNECT_ACTION = "Reconnect Bitwarden";
const LOCK_ACTION = "Lock Pi credentials";
const CLOSE_ACTION = "Close";

const USER_PASSWORD_KIND = "Username and password";
const KEY_KIND = "API token or private key";
const DOTENV_KIND = "Environment variables (.env format)";

export interface SecretMenuControllerOptions {
	manager: CredentialManager;
	cwd: string;
}

function safeErrorMessage(error: unknown): string {
	if (
		error instanceof CredentialManagerError ||
		error instanceof CredentialStorageError ||
		error instanceof SecretDotenvError
	) {
		return error.message;
	}
	return "Credential operation failed safely without exposing private data.";
}

async function openPrivateEditor(
	ui: ExtensionUIContext,
	title: string,
	prefill: string,
	notice: string,
): Promise<string | undefined> {
	return ui.custom<string | undefined>(
		(tui, _theme, keybindings, done) =>
			new ExtensionEditorComponent(
				tui,
				keybindings,
				title,
				prefill,
				(value) => done(value),
				() => done(undefined),
				{
					privateContent: true,
					allowExternalEditor: false,
					notice,
				},
			),
	);
}

function unquoteDroppedPath(value: string): string {
	if (value.length < 2) return value;
	const first = value[0];
	return (first === '"' || first === "'") && value.at(-1) === first ? value.slice(1, -1) : value;
}

async function resolvePrivateValue(editorValue: string): Promise<string> {
	const pathCandidate = unquoteDroppedPath(editorValue.trim());
	if (!isAbsolute(pathCandidate)) return editorValue;
	const metadata = await stat(pathCandidate).catch(() => undefined);
	if (!metadata?.isFile()) throw new SecretDotenvError("dropped key file was not found or is not a regular file");
	if (metadata.size > MAX_DOTENV_VALUE_BYTES) {
		throw new SecretDotenvError("dropped key file exceeds the 64 KiB value limit");
	}
	return readFile(pathCandidate, "utf8");
}

export class SecretMenuController {
	private readonly manager: CredentialManager;
	private readonly cwd: string;

	constructor(options: SecretMenuControllerOptions) {
		this.manager = options.manager;
		this.cwd = options.cwd;
	}

	async open(ui: ExtensionUIContext): Promise<void> {
		let profiles: CredentialProfileSummary[] | undefined;
		if (!this.manager.status.connected && this.manager.status.sessionAvailable) {
			try {
				profiles = await this.manager.listForProject(this.cwd);
			} catch {
				// A stale BW_SESSION falls through to the one-field owner reconnect flow.
			}
		}
		if (!this.manager.status.connected) {
			if (!(await this.connect(ui))) return;
		}
		while (true) {
			try {
				profiles ??= await this.manager.listForProject(this.cwd);
				const actions = [ADD_ACTION];
				if (profiles.some((profile) => profile.boundToCurrentProject)) actions.push(ACTIVATE_ACTION);
				if (profiles.some((profile) => !profile.boundToCurrentProject)) actions.push(BIND_ACTION);
				if (profiles.length > 0) actions.push(REMOVE_ACTION);
				actions.push(RECONNECT_ACTION, LOCK_ACTION, CLOSE_ACTION);
				const action = await ui.select("Secrets · Bitwarden", actions);
				switch (action) {
					case ADD_ACTION:
						await this.addOrUpdate(ui, profiles);
						profiles = undefined;
						continue;
					case ACTIVATE_ACTION:
						await this.activate(ui, profiles);
						continue;
					case BIND_ACTION:
						await this.bind(ui, profiles);
						profiles = undefined;
						continue;
					case REMOVE_ACTION:
						await this.remove(ui, profiles);
						profiles = undefined;
						continue;
					case RECONNECT_ACTION:
						this.manager.lock();
						if (!(await this.connect(ui))) return;
						profiles = undefined;
						continue;
					case LOCK_ACTION:
						this.manager.lock();
						ui.notify("Pi credential access is locked for this session.", "info");
						return;
					case CLOSE_ACTION:
					case undefined:
						return;
				}
			} catch (error) {
				ui.notify(safeErrorMessage(error), "error");
				return;
			}
		}
	}

	private async connect(ui: ExtensionUIContext): Promise<boolean> {
		while (true) {
			let sessionKey = await ui.input("Connect Bitwarden", "Paste BW_SESSION session key", {
				sensitive: true,
			});
			if (sessionKey === undefined) return false;
			try {
				await this.manager.connect(sessionKey);
				ui.notify("Bitwarden connected. Pi keeps the session key in memory only.", "info");
				return true;
			} catch (error) {
				ui.notify(safeErrorMessage(error), "error");
			} finally {
				sessionKey = "";
			}
		}
	}

	private async addOrUpdate(ui: ExtensionUIContext, profiles: CredentialProfileSummary[]): Promise<void> {
		const profileInput = await ui.input("Credential profile", "Example: deploy-prod");
		if (profileInput === undefined) return;
		const profile = profileInput.trim();
		if (!profile) {
			ui.notify("Credential profile name is required.", "error");
			return;
		}
		if (profiles.some((candidate) => candidate.profile === profile)) {
			const approved = await ui.confirm(
				"Update credential profile",
				`Replace the stored values for ${profile} while preserving its project bindings?`,
			);
			if (!approved) return;
		}
		const descriptionInput = await ui.input("Description", "Optional non-secret description");
		if (descriptionInput === undefined) return;
		const description = descriptionInput.trim() || undefined;
		const kind = await ui.select("Credential shape", [USER_PASSWORD_KIND, KEY_KIND, DOTENV_KIND]);
		if (!kind) return;
		let dotenv = "";
		try {
			if (kind === USER_PASSWORD_KIND) dotenv = (await this.captureUserPassword(ui)) ?? "";
			else if (kind === KEY_KIND) dotenv = (await this.captureKey(ui)) ?? "";
			else dotenv = (await this.captureDotenv(ui)) ?? "";
			if (!dotenv) return;
			const stored = await this.manager.storeForProject(this.cwd, { profile, description, dotenv });
			ui.notify(
				`Stored and activated ${stored.profile} (${stored.variableNames.length} variables) in Bitwarden.`,
				"info",
			);
			if (stored.portable === false) {
				ui.notify("This project has no portable Git remote, so its binding is local to this machine.", "warning");
			}
		} catch (error) {
			ui.notify(safeErrorMessage(error), "error");
		} finally {
			dotenv = "";
		}
	}

	private async captureUserPassword(ui: ExtensionUIContext): Promise<string | undefined> {
		const usernameVariableInput = await ui.input("Username variable", "USERNAME");
		if (usernameVariableInput === undefined) return undefined;
		const usernameVariable = usernameVariableInput.trim() || "USERNAME";
		let username = await ui.input("Username", "Type the account username", { sensitive: true });
		if (username === undefined) return undefined;
		const passwordVariableInput = await ui.input("Password variable", "PASSWORD");
		if (passwordVariableInput === undefined) {
			username = "";
			return undefined;
		}
		const passwordVariable = passwordVariableInput.trim() || "PASSWORD";
		let password = await ui.input("Password", "Type the account password", { sensitive: true });
		if (password === undefined) {
			username = "";
			return undefined;
		}
		try {
			return formatDotenvVariables([
				{ name: usernameVariable, value: username },
				{ name: passwordVariable, value: password },
			]);
		} finally {
			username = "";
			password = "";
		}
	}

	private async captureKey(ui: ExtensionUIContext): Promise<string | undefined> {
		const variableInput = await ui.input("Key variable", "API_KEY");
		if (variableInput === undefined) return undefined;
		const variable = variableInput.trim() || "API_KEY";
		let editorValue = await openPrivateEditor(
			ui,
			`Private value · ${variable}`,
			"",
			"Paste a token/key, or drag an absolute key-file path here · never sent to the model",
		);
		if (editorValue === undefined) return undefined;
		let value = "";
		try {
			value = await resolvePrivateValue(editorValue);
			return formatDotenvVariables([{ name: variable, value }]);
		} finally {
			editorValue = "";
			value = "";
		}
	}

	private async captureDotenv(ui: ExtensionUIContext): Promise<string | undefined> {
		let draft = "# NAME=value\n";
		while (true) {
			const edited = await openPrivateEditor(
				ui,
				"Environment credentials",
				draft,
				"Private .env editor · paste one or more NAME=value entries · never sent to the model",
			);
			if (edited === undefined) return undefined;
			try {
				const parsed = parseDotenvDocument(edited);
				draft = "";
				return parsed.document;
			} catch (error) {
				ui.notify(safeErrorMessage(error), "error");
				draft = edited;
			}
		}
	}

	private async activate(ui: ExtensionUIContext, profiles: CredentialProfileSummary[]): Promise<void> {
		const bound = profiles.filter((profile) => profile.boundToCurrentProject);
		const profile = await ui.select(
			"Activate credentials",
			bound.map((candidate) => candidate.profile),
		);
		if (!profile) return;
		const activated = await this.manager.activateForProject(this.cwd, profile);
		ui.notify(
			`Activated ${activated.profile} for ${activated.project} (${activated.variableNames.length} variables).`,
			"info",
		);
	}

	private async bind(ui: ExtensionUIContext, profiles: CredentialProfileSummary[]): Promise<void> {
		const unbound = profiles.filter((profile) => !profile.boundToCurrentProject);
		const profile = await ui.select(
			"Use profile in this project",
			unbound.map((candidate) => candidate.profile),
		);
		if (!profile) return;
		const bound = await this.manager.bindProfileToProject(this.cwd, profile);
		ui.notify(`Bound ${bound.profile} to ${bound.project}.`, "info");
		if (bound.portable === false) {
			ui.notify("This project has no portable Git remote, so its binding is local to this machine.", "warning");
		}
	}

	private async remove(ui: ExtensionUIContext, profiles: CredentialProfileSummary[]): Promise<void> {
		const profile = await ui.select(
			"Remove credential profile",
			profiles.map((candidate) => candidate.profile),
		);
		if (!profile) return;
		const approved = await ui.confirm(
			"Remove credential profile",
			`Move ${profile} to Bitwarden trash and clear its active environment?`,
		);
		if (!approved) return;
		const removed = await this.manager.removeProfile(profile);
		ui.notify(`Removed ${removed.profile} (${removed.variableNames.length} variables).`, "info");
	}
}
