import { type Static, Type } from "typebox";
import { ExtensionEditorComponent } from "../../modes/interactive/components/extension-editor.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { defineTool, type ExtensionContext } from "../extensions/types.ts";
import { parseDotenvDocument, SecretDotenvError } from "../secrets/secret-dotenv.ts";
import {
	MAX_VARIABLES_PER_PROFILE,
	SECRET_DESCRIPTION_MAX_CHARS,
	SECRET_PRINTABLE_METADATA_PATTERN,
	SECRET_PROFILE_ID_MAX_CHARS,
	SECRET_PROFILE_ID_PATTERN,
	SECRET_VARIABLE_NAME_MAX_CHARS,
	SECRET_VARIABLE_NAME_PATTERN,
	type SecretProfileSummary,
	SecretVault,
	SecretVaultError,
} from "../secrets/secret-vault.ts";
import {
	emptyOrchestrationCall,
	OrchestrationPanelComponent,
	type OrchestrationPanelModel,
} from "./orchestration-panel.ts";

const secretStoreSchema = Type.Object(
	{
		action: Type.Union(
			[
				Type.Literal("set"),
				Type.Literal("list"),
				Type.Literal("materialize"),
				Type.Literal("remove"),
				Type.Literal("lock"),
			],
			{ description: "Credential-management action." },
		),
		profile: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: SECRET_PROFILE_ID_MAX_CHARS,
				pattern: SECRET_PROFILE_ID_PATTERN,
				description: "Portable profile identifier, such as project-dev or aws-work.",
			}),
		),
		description: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: SECRET_DESCRIPTION_MAX_CHARS,
				pattern: SECRET_PRINTABLE_METADATA_PATTERN,
				description: "Non-secret profile description.",
			}),
		),
		envFile: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 512,
				description:
					"Relative dotenv location inside the current workspace, such as .env, .env.local, or config/dev.env. Valid only for set.",
			}),
		),
		variableNames: Type.Optional(
			Type.Array(
				Type.String({
					minLength: 1,
					maxLength: SECRET_VARIABLE_NAME_MAX_CHARS,
					pattern: SECRET_VARIABLE_NAME_PATTERN,
				}),
				{
					minItems: 1,
					maxItems: MAX_VARIABLES_PER_PROFILE,
					description: "Specific variable names to remove. Omit to remove the whole profile.",
				},
			),
		),
		scope: Type.Optional(
			Type.Union([Type.Literal("managed"), Type.Literal("workspace")], {
				description:
					"Materialization target. workspace resolves the durable current-project binding; managed writes private Pi state.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type SecretStoreToolInput = Static<typeof secretStoreSchema>;

export type SecretStoreStatus =
	| "cancelled"
	| "error"
	| "listed"
	| "locked"
	| "materialized"
	| "removed"
	| "stored"
	| "unavailable";

export interface SecretStoreToolDetails {
	action: SecretStoreToolInput["action"];
	status: SecretStoreStatus;
	profile?: string;
	variableNames?: string[];
	profiles?: SecretProfileSummary[];
	scope?: "managed" | "workspace";
	envFile?: string;
	materialized?: boolean;
	code?: string;
	message?: string;
}

export interface SecretStoreToolOptions {
	agentDir?: string;
	vault?: SecretVault;
}

type SecretStoreResult = {
	content: Array<{ type: "text"; text: string }>;
	details: SecretStoreToolDetails;
};

function result(details: SecretStoreToolDetails, text: string): SecretStoreResult {
	return { content: [{ type: "text", text }], details };
}

function cancelled(action: SecretStoreToolInput["action"], profile?: string): SecretStoreResult {
	return result(
		{ action, status: "cancelled", ...(profile ? { profile } : {}), code: "owner_cancelled" },
		"Secret store action was cancelled by the owner.",
	);
}

function failed(action: SecretStoreToolInput["action"], error: unknown, profile?: string): SecretStoreResult {
	const code = error instanceof SecretVaultError ? error.code : "safe_failure";
	const message =
		error instanceof SecretVaultError ? error.message : "Secret store failed safely without exposing values.";
	return result(
		{ action, status: "error", ...(profile ? { profile } : {}), code, message },
		`Secret store failed: ${message}`,
	);
}

function invalid(
	action: SecretStoreToolInput["action"],
	code: string,
	message: string,
	profile?: string,
): SecretStoreResult {
	return result(
		{ action, status: "error", ...(profile ? { profile } : {}), code, message },
		`Secret store request is invalid: ${message}`,
	);
}

function panelModel(details: SecretStoreToolDetails | undefined, expanded: boolean): OrchestrationPanelModel {
	if (!details) return { label: "secrets", status: "error", emptyText: "No secret-store result was retained." };
	const success = ["listed", "locked", "materialized", "removed", "stored"].includes(details.status);
	const rows = expanded
		? (details.profiles ?? []).map((profile) => ({
				status: "info" as const,
				label: profile.profile,
				meta: [
					`${profile.variableNames.length} variable${profile.variableNames.length === 1 ? "" : "s"}`,
					`${profile.bindings.length} binding${profile.bindings.length === 1 ? "" : "s"}`,
				],
				details: [
					...(profile.description ? [profile.description] : []),
					...profile.bindings.map((binding) => `${binding.envFile} · ${binding.workspace}`),
				],
			}))
		: undefined;
	return {
		label: "secrets",
		action: details.status,
		status: success ? "success" : details.status === "cancelled" ? "warning" : "error",
		summary: [
			details.profile,
			details.envFile,
			details.scope,
			details.variableNames
				? `${details.variableNames.length} variable${details.variableNames.length === 1 ? "" : "s"}`
				: undefined,
			details.profiles ? `${details.profiles.length} profile${details.profiles.length === 1 ? "" : "s"}` : undefined,
		].filter((value): value is string => value !== undefined),
		rows,
		notices:
			expanded && details.message ? [{ status: success ? "info" : "error", text: details.message }] : undefined,
	};
}

async function ensureUnlocked(
	vault: SecretVault,
	action: SecretStoreToolInput["action"],
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	profile?: string,
): Promise<SecretStoreResult | undefined> {
	if (vault.isUnlocked) return undefined;
	if (await vault.exists()) {
		while (!signal?.aborted) {
			let passphrase = await ctx.ui.input("Unlock secret vault", "Master passphrase", {
				signal,
				sensitive: true,
			});
			if (passphrase === undefined || signal?.aborted) return cancelled(action, profile);
			try {
				await vault.unlock(passphrase);
				return undefined;
			} catch (error) {
				if (error instanceof SecretVaultError && ["invalid_passphrase", "unlock_failed"].includes(error.code)) {
					ctx.ui.notify(error.message, "error");
					continue;
				}
				return failed(action, error, profile);
			} finally {
				passphrase = "";
			}
		}
		return cancelled(action, profile);
	}

	while (!signal?.aborted) {
		let passphrase = await ctx.ui.input("Create secret vault", "New master passphrase", { signal, sensitive: true });
		if (passphrase === undefined || signal?.aborted) return cancelled(action, profile);
		let confirmation = await ctx.ui.input("Confirm secret vault", "Repeat master passphrase", {
			signal,
			sensitive: true,
		});
		if (confirmation === undefined || signal?.aborted) {
			passphrase = "";
			return cancelled(action, profile);
		}
		try {
			if (passphrase !== confirmation) {
				ctx.ui.notify("The two master passphrases do not match.", "error");
				continue;
			}
			await vault.initialize(passphrase);
			return undefined;
		} catch (error) {
			if (error instanceof SecretVaultError && error.code === "invalid_passphrase") {
				ctx.ui.notify(error.message, "error");
				continue;
			}
			return failed(action, error, profile);
		} finally {
			passphrase = "";
			confirmation = "";
		}
	}
	return cancelled(action, profile);
}

function validateInput(input: SecretStoreToolInput): SecretStoreResult | undefined {
	if (input.action === "lock" || input.action === "list") {
		if (
			input.profile !== undefined ||
			input.description !== undefined ||
			input.envFile !== undefined ||
			input.variableNames !== undefined ||
			input.scope !== undefined
		) {
			return invalid(input.action, "unexpected_fields", `Action ${input.action} does not accept profile fields.`);
		}
		return undefined;
	}
	if (input.action === "set" && !input.profile) {
		return invalid(input.action, "profile_required", "Action set requires a profile.");
	}
	if (input.action === "remove" && !input.profile) {
		return invalid(input.action, "profile_required", "Action remove requires a profile.");
	}
	if (input.action !== "set" && (input.description !== undefined || input.envFile !== undefined)) {
		return invalid(
			input.action,
			"unexpected_profile_fields",
			"description and envFile are valid only for set.",
			input.profile,
		);
	}
	if (input.action !== "remove" && input.variableNames !== undefined) {
		return invalid(
			input.action,
			"unexpected_variable_names",
			"variableNames is valid only for remove.",
			input.profile,
		);
	}
	if (input.action !== "materialize" && input.scope !== undefined) {
		return invalid(input.action, "unexpected_scope", "scope is valid only for materialize.", input.profile);
	}
	if (input.variableNames && new Set(input.variableNames).size !== input.variableNames.length) {
		return invalid(input.action, "duplicate_variables", "Variable names must be unique.", input.profile);
	}
	return undefined;
}

async function openPrivateDotenvEditor(
	ctx: ExtensionContext,
	title: string,
	prefill: string,
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	if (signal?.aborted) return undefined;
	try {
		return await ctx.ui.custom<string | undefined>(
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
						signal,
						notice: "Private plaintext editor · content stays local and never enters model context",
					},
				),
		);
	} catch (error) {
		if (signal?.aborted) return undefined;
		throw error;
	}
}

async function captureValidDotenv(
	ctx: ExtensionContext,
	title: string,
	prefill: string,
	signal: AbortSignal | undefined,
): Promise<{ document: string; variableNames: string[] } | undefined> {
	let draft = prefill;
	while (!signal?.aborted) {
		const edited = await openPrivateDotenvEditor(ctx, title, draft, signal);
		if (edited === undefined || signal?.aborted) return undefined;
		try {
			const parsed = parseDotenvDocument(edited);
			const variableNames = parsed.variables.map((variable) => variable.name);
			for (const variable of parsed.variables) variable.value = "";
			draft = "";
			return { document: parsed.document, variableNames };
		} catch (error) {
			ctx.ui.notify(error instanceof SecretDotenvError ? error.message : "The dotenv document is invalid.", "error");
			draft = edited;
		}
	}
	return undefined;
}

async function executeSet(
	vault: SecretVault,
	input: SecretStoreToolInput & { profile: string },
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<SecretStoreResult> {
	let document = "";
	let originalUnmanagedContent: string | undefined;
	try {
		const target = vault.resolveBindingTarget(ctx.cwd, input.envFile ?? ".env");
		const destinationState = await vault.inspectEnvDestination(target.destination, input.profile);
		if (destinationState === "managed-other") {
			return invalid(
				input.action,
				"destination_conflict",
				"The selected dotenv location is already managed by another profile.",
				input.profile,
			);
		}
		const storedDocument = await vault.getProfileDocument(input.profile);
		let prefill = storedDocument ?? "";
		if (destinationState === "unmanaged") {
			originalUnmanagedContent = await vault.readOwnerDotenv(target.destination);
			prefill = originalUnmanagedContent;
		}
		if (destinationState === "managed-profile" && storedDocument === undefined) {
			return invalid(
				input.action,
				"profile_missing",
				"The dotenv target claims this profile, but the encrypted profile is missing.",
				input.profile,
			);
		}

		const captured = await captureValidDotenv(
			ctx,
			`Secrets · ${input.profile}  →  ${target.destination}`,
			prefill,
			signal,
		);
		prefill = "";
		if (!captured) return cancelled(input.action, input.profile);
		document = captured.document;
		await vault.replaceProfileDocument(input.profile, input.description, document, {
			workspace: target.workspace,
			envFile: target.envFile,
		});
		try {
			await vault.materializeEnv(input.profile, target.destination, {
				allowReplaceUnmanaged: destinationState === "unmanaged",
				expectedUnmanagedContent: originalUnmanagedContent,
			});
		} catch (error) {
			const message = error instanceof SecretVaultError ? error.message : "Dotenv materialization failed safely.";
			ctx.ui.notify(`Profile stored, but ${target.destination} was not refreshed: ${message}`, "warning");
			return result(
				{
					action: input.action,
					status: "stored",
					profile: input.profile,
					envFile: target.envFile,
					variableNames: captured.variableNames,
					materialized: false,
					code: "materialization_failed",
					message,
				},
				`Stored profile ${input.profile}, but its bound dotenv could not be refreshed. Retry secret_store materialize; no values were exposed.`,
			);
		}
		ctx.ui.notify(`Credential profile ${input.profile} stored and activated at ${target.destination}`, "info");
		return result(
			{
				action: input.action,
				status: "stored",
				profile: input.profile,
				envFile: target.envFile,
				variableNames: captured.variableNames,
				materialized: true,
			},
			`Stored and activated ${captured.variableNames.length} variables for profile ${input.profile} at its bound workspace dotenv location. Values never entered model context.`,
		);
	} catch (error) {
		return failed(input.action, error, input.profile);
	} finally {
		document = "";
		originalUnmanagedContent = undefined;
	}
}

async function executeMaterialize(
	vault: SecretVault,
	input: SecretStoreToolInput,
	ctx: ExtensionContext,
): Promise<SecretStoreResult> {
	try {
		const scope = input.scope ?? "workspace";
		const binding = await vault.resolveBindingForWorkspace(ctx.cwd, input.profile);
		const destination = scope === "managed" ? vault.getManagedEnvPath(binding.profile) : binding.destination;
		const destinationState = await vault.inspectEnvDestination(destination, binding.profile);
		if (destinationState === "unmanaged" || destinationState === "managed-other") {
			return invalid(
				input.action,
				"destination_conflict",
				"The bound dotenv location is no longer safely managed. Use set to review it in the private editor.",
				binding.profile,
			);
		}
		const materialized = await vault.materializeEnv(binding.profile, destination, {
			activationWorkspace: ctx.cwd,
			managed: scope === "managed",
		});
		ctx.ui.notify(`Credential profile ${binding.profile} activated at ${destination}`, "info");
		return result(
			{
				action: input.action,
				status: "materialized",
				profile: binding.profile,
				variableNames: materialized.variableNames,
				scope,
				envFile: scope === "workspace" ? binding.envFile : undefined,
				materialized: true,
			},
			`Activated profile ${binding.profile} for the current workspace. Its dotenv and process environment are available without exposing values to the model.`,
		);
	} catch (error) {
		return failed(input.action, error, input.profile);
	}
}

async function executeRemove(
	vault: SecretVault,
	input: SecretStoreToolInput & { profile: string },
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<SecretStoreResult> {
	const target = input.variableNames?.length
		? `${input.variableNames.join(", ")} from profile ${input.profile}`
		: `the entire profile ${input.profile}`;
	const approved = await ctx.ui.confirm(
		"Remove stored secrets",
		`Remove ${target}? Pi-managed workspace and private dotenv copies are invalidated.`,
		{ signal },
	);
	if (!approved || signal?.aborted) return cancelled(input.action, input.profile);
	try {
		const removal = await vault.removeProfile(input.profile, input.variableNames);
		return result(
			{
				action: input.action,
				status: "removed",
				profile: input.profile,
				variableNames: removal.removedVariableNames,
			},
			`Removed ${removal.removedVariableNames.length} secret variable${removal.removedVariableNames.length === 1 ? "" : "s"} from profile ${input.profile}.`,
		);
	} catch (error) {
		return failed(input.action, error, input.profile);
	}
}

export function createSecretStoreToolDefinition(options: SecretStoreToolOptions) {
	const vault = options.vault ?? (options.agentDir ? SecretVault.forAgentDir(options.agentDir) : undefined);
	if (!vault) throw new Error("secret_store requires an agentDir or SecretVault");
	return defineTool<typeof secretStoreSchema, SecretStoreToolDetails>({
		name: "secret_store",
		label: "Secret Store",
		description:
			"Open a model-blind native dotenv editor, encrypt owner credentials, bind profiles to workspace dotenv locations, and activate them for normal process use without returning values to the model.",
		promptSnippet:
			"Manage credentials through the model-blind secret vault. Before credential-dependent work, materialize the current workspace binding; use set to open the owner's private dotenv editor.",
		promptGuidelines: [
			"Use secret_store whenever credentials are needed. Never ask the owner to paste a secret into chat or place a value in tool arguments.",
			"Use set with a profile and relative envFile. The harness opens a private plaintext editor, persists the workspace binding, writes the dotenv, and activates the environment.",
			"Before credential-dependent commands in a later session, call materialize without a profile to resolve the current workspace binding. Use list only when selection or discovery is needed.",
			"After activation, run the consuming application normally. Never read, grep, print, echo, source, or otherwise inspect credential files or environment values.",
			"Treat cancellation as owner intent. Do not immediately repeat the same credential request.",
		],
		parameters: secretStoreSchema,
		executionMode: "sequential",
		renderShell: "self",
		renderCall() {
			return emptyOrchestrationCall();
		},
		renderResult(toolResult, { expanded, isPartial }, theme: Theme) {
			if (isPartial) {
				return new OrchestrationPanelComponent(theme, {
					label: "secrets",
					action: "waiting for you",
					status: "running",
				});
			}
			return new OrchestrationPanelComponent(theme, panelModel(toolResult.details, expanded), expanded);
		},
		async execute(_toolCallId, input, signal, _onUpdate, ctx) {
			if (!ctx.hasUI || ctx.mode !== "tui") {
				return result(
					{
						action: input.action,
						status: "unavailable",
						...(input.profile ? { profile: input.profile } : {}),
						code: "user_tui_required",
						message: "Secret values can be captured only in a user-visible TUI session.",
					},
					"secret_store requires a user-visible TUI session.",
				);
			}
			if (signal?.aborted) return cancelled(input.action, input.profile);
			const validation = validateInput(input);
			if (validation) return validation;
			if (input.action === "lock") {
				vault.lock();
				return result(
					{ action: input.action, status: "locked" },
					"Secret vault locked; cached key, credential environment, and exact-value redaction cache were cleared.",
				);
			}
			try {
				const unlockResult = await ensureUnlocked(vault, input.action, ctx, signal, input.profile);
				if (unlockResult) return unlockResult;
				if (input.action === "list") {
					const profiles = await vault.listProfiles();
					return result(
						{ action: input.action, status: "listed", profiles },
						`Secret vault contains ${profiles.length} profile${profiles.length === 1 ? "" : "s"}. Only names, variable names, and workspace bindings were returned.`,
					);
				}
				if (input.action === "set" && input.profile) {
					return executeSet(vault, { ...input, profile: input.profile }, ctx, signal);
				}
				if (input.action === "materialize") return executeMaterialize(vault, input, ctx);
				if (!input.profile) return invalid(input.action, "profile_required", "A profile is required.");
				return executeRemove(vault, { ...input, profile: input.profile }, ctx, signal);
			} catch (error) {
				return failed(input.action, error, input.profile);
			}
		},
	});
}
