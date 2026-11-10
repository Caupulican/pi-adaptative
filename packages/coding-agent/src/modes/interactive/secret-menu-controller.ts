import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ExtensionUIContext } from "../../core/extensions/types.ts";
import { interfaceText } from "../../core/language/interface-text.ts";
import {
	type CredentialManager,
	CredentialManagerError,
	type CredentialProfileSummary,
	CredentialStorageError,
} from "../../core/secrets/credential-manager.ts";
import { isCredentialSessionKeyRequired } from "../../core/secrets/credential-session-connection.ts";
import {
	formatDotenvVariables,
	MAX_DOTENV_VALUE_BYTES,
	parseDotenvDocument,
	SecretDotenvError,
} from "../../core/secrets/secret-dotenv.ts";
import { ExtensionEditorComponent } from "./components/extension-editor.ts";

/** The actions the menu offers. The list shows their labels; the controller acts on these identifiers. */
type SecretMenuAction = "add" | "activate" | "bind" | "remove" | "reconnect" | "lock" | "close";

/** The shapes a new credential can take. Also an identifier, labelled by the catalogue. */
type CredentialShape = "userPassword" | "key" | "dotenv";

/** Turn the chosen label back into the identifier it stands for. */
function identifierOf<T extends string>(options: T[], labels: string[], chosen: string | undefined): T | undefined {
	if (chosen === undefined) return undefined;
	return options[labels.indexOf(chosen)];
}

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
	return interfaceText().secretsScreen.notices.failedSafely;
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
	if (!metadata?.isFile()) throw new SecretDotenvError(interfaceText().secretsScreen.notices.keyFileMissing);
	if (metadata.size > MAX_DOTENV_VALUE_BYTES) {
		throw new SecretDotenvError(interfaceText().secretsScreen.notices.keyFileTooLarge);
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
		const text = interfaceText().secretsScreen;
		let profiles: CredentialProfileSummary[] | undefined;
		if (!this.manager.status.connected && this.manager.status.sessionAvailable) {
			try {
				profiles = await this.manager.listForProject(this.cwd);
			} catch {
				// A stale BW_SESSION surfaces the environment-setup notice below.
			}
		}
		if (!this.manager.status.connected) {
			ui.notify(text.notices.machineSetup, "error");
			return;
		}
		while (true) {
			try {
				profiles ??= await this.manager.listForProject(this.cwd);
				const actions: SecretMenuAction[] = ["add"];
				if (profiles.some((profile) => profile.boundToCurrentProject)) actions.push("activate");
				if (profiles.some((profile) => !profile.boundToCurrentProject)) actions.push("bind");
				if (profiles.length > 0) actions.push("remove");
				actions.push("reconnect", "lock", "close");
				const labels = actions.map((value) => text.actions[value]);
				const action = identifierOf(actions, labels, await ui.select(text.title, labels));
				switch (action) {
					case "add":
						await this.addOrUpdate(ui, profiles);
						profiles = undefined;
						continue;
					case "activate":
						await this.activate(ui, profiles);
						continue;
					case "bind":
						await this.bind(ui, profiles);
						profiles = undefined;
						continue;
					case "remove":
						await this.remove(ui, profiles);
						profiles = undefined;
						continue;
					case "reconnect":
						this.manager.lock();
						try {
							await this.manager.ensureAvailable();
							profiles = await this.manager.listForProject(this.cwd);
							ui.notify(text.notices.reconnected, "info");
							continue;
						} catch (error) {
							this.manager.lock();
							ui.notify(
								isCredentialSessionKeyRequired(error) ? text.notices.machineSetup : safeErrorMessage(error),
								"error",
							);
							return;
						}
					case "lock":
						this.manager.lock();
						ui.notify(text.notices.locked, "info");
						return;
					case "close":
					case undefined:
						return;
				}
			} catch (error) {
				ui.notify(safeErrorMessage(error), "error");
				return;
			}
		}
	}

	private async addOrUpdate(ui: ExtensionUIContext, profiles: CredentialProfileSummary[]): Promise<void> {
		const text = interfaceText().secretsScreen;
		const profileInput = await ui.input(text.prompts.profile, text.prompts.profilePlaceholder);
		if (profileInput === undefined) return;
		const profile = profileInput.trim();
		if (!profile) {
			ui.notify(text.notices.profileRequired, "error");
			return;
		}
		if (profiles.some((candidate) => candidate.profile === profile)) {
			const approved = await ui.confirm(text.prompts.updateTitle, text.prompts.updateBody(profile));
			if (!approved) return;
		}
		const descriptionInput = await ui.input(text.prompts.description, text.prompts.descriptionPlaceholder);
		if (descriptionInput === undefined) return;
		const description = descriptionInput.trim() || undefined;
		const shapes: CredentialShape[] = ["userPassword", "key", "dotenv"];
		const shapeLabels = shapes.map((shape) => text.shapes[shape]);
		const kind = identifierOf(shapes, shapeLabels, await ui.select(text.prompts.shape, shapeLabels));
		if (!kind) return;
		let dotenv = "";
		try {
			if (kind === "userPassword") dotenv = (await this.captureUserPassword(ui)) ?? "";
			else if (kind === "key") dotenv = (await this.captureKey(ui)) ?? "";
			else dotenv = (await this.captureDotenv(ui)) ?? "";
			if (!dotenv) return;
			const stored = await this.manager.storeForProject(this.cwd, { profile, description, dotenv });
			ui.notify(text.prompts.stored(stored.profile, text.variableCount(stored.variableNames.length)), "info");
			if (stored.portable === false) {
				ui.notify(text.notices.noGitRemote, "warning");
			}
		} catch (error) {
			ui.notify(safeErrorMessage(error), "error");
		} finally {
			dotenv = "";
		}
	}

	private async captureUserPassword(ui: ExtensionUIContext): Promise<string | undefined> {
		const text = interfaceText().secretsScreen;
		const usernameVariableInput = await ui.input(text.prompts.usernameVariable, "USERNAME");
		if (usernameVariableInput === undefined) return undefined;
		const usernameVariable = usernameVariableInput.trim() || "USERNAME";
		let username = await ui.input(text.prompts.username, text.prompts.usernamePlaceholder, { sensitive: true });
		if (username === undefined) return undefined;
		const passwordVariableInput = await ui.input(text.prompts.passwordVariable, "PASSWORD");
		if (passwordVariableInput === undefined) {
			username = "";
			return undefined;
		}
		const passwordVariable = passwordVariableInput.trim() || "PASSWORD";
		let password = await ui.input(text.prompts.password, text.prompts.passwordPlaceholder, { sensitive: true });
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
		const text = interfaceText().secretsScreen;
		const variableInput = await ui.input(text.prompts.keyVariable, "API_KEY");
		if (variableInput === undefined) return undefined;
		const variable = variableInput.trim() || "API_KEY";
		let editorValue = await openPrivateEditor(
			ui,
			text.prompts.privateValueTitle(variable),
			"",
			text.prompts.privateValueNotice,
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
			const text = interfaceText().secretsScreen;
			const edited = await openPrivateEditor(
				ui,
				text.prompts.environmentTitle,
				draft,
				text.prompts.environmentNotice,
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
		const text = interfaceText().secretsScreen;
		const profile = await ui.select(
			text.prompts.activateTitle,
			bound.map((candidate) => candidate.profile),
		);
		if (!profile) return;
		const activated = await this.manager.activateForProject(this.cwd, profile);
		ui.notify(
			text.prompts.activated(
				activated.profile,
				activated.project,
				text.variableCount(activated.variableNames.length),
			),
			"info",
		);
	}

	private async bind(ui: ExtensionUIContext, profiles: CredentialProfileSummary[]): Promise<void> {
		const unbound = profiles.filter((profile) => !profile.boundToCurrentProject);
		const text = interfaceText().secretsScreen;
		const profile = await ui.select(
			text.prompts.bindTitle,
			unbound.map((candidate) => candidate.profile),
		);
		if (!profile) return;
		const bound = await this.manager.bindProfileToProject(this.cwd, profile);
		ui.notify(text.prompts.bound(bound.profile, bound.project ?? ""), "info");
		if (bound.portable === false) {
			ui.notify(text.notices.noGitRemote, "warning");
		}
	}

	private async remove(ui: ExtensionUIContext, profiles: CredentialProfileSummary[]): Promise<void> {
		const text = interfaceText().secretsScreen;
		const profile = await ui.select(
			text.prompts.removeTitle,
			profiles.map((candidate) => candidate.profile),
		);
		if (!profile) return;
		const approved = await ui.confirm(text.prompts.removeTitle, text.prompts.removeBody(profile));
		if (!approved) return;
		const removed = await this.manager.removeProfile(profile);
		ui.notify(text.prompts.removed(removed.profile, text.variableCount(removed.variableNames.length)), "info");
	}
}
