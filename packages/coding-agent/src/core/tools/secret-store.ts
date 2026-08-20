import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { defineTool } from "../extensions/types.ts";
import {
	type CredentialManager,
	CredentialManagerError,
	type CredentialProfileSummary,
	CredentialStorageError,
} from "../secrets/credential-manager.ts";
import {
	CredentialMigrationSourceError,
	type CredentialMigrationSourceResolver,
	resolveCredentialMigrationSources,
} from "../secrets/credential-migration-source.ts";
import {
	connectCredentialSessionWithMaskedPrompt,
	isCredentialSessionKeyRequired,
} from "../secrets/credential-session-connection.ts";
import {
	CredentialMigrationDiscoveryError,
	type CredentialMigrationSourceCandidate,
	type CredentialMigrationSourceDiscoverer,
	discoverCredentialMigrationSources,
} from "../secrets/credential-source-discovery.ts";
import { SECRET_VARIABLE_NAME_MAX_CHARS, SECRET_VARIABLE_NAME_PATTERN } from "../secrets/secret-dotenv.ts";
import {
	emptyOrchestrationCall,
	OrchestrationPanelComponent,
	type OrchestrationPanelModel,
} from "./orchestration-panel.ts";

const migrationSourceSchema = Type.Union([
	Type.Object(
		{
			kind: Type.Literal("environment"),
			name: Type.String({ maxLength: SECRET_VARIABLE_NAME_MAX_CHARS, pattern: SECRET_VARIABLE_NAME_PATTERN }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ kind: Type.Literal("dotenv_file"), path: Type.String({ minLength: 1, maxLength: 4096 }) },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("file"),
			path: Type.String({ minLength: 1, maxLength: 4096 }),
			variable: Type.String({ maxLength: SECRET_VARIABLE_NAME_MAX_CHARS, pattern: SECRET_VARIABLE_NAME_PATTERN }),
		},
		{ additionalProperties: false },
	),
]);

const secretStoreSchema = Type.Object(
	{
		action: Type.Union(
			[
				Type.Literal("status"),
				Type.Literal("list"),
				Type.Literal("discover"),
				Type.Literal("activate"),
				Type.Literal("migrate"),
			],
			{
				description: "Inspect, discover, activate, or migrate model-blind credential sources.",
			},
		),
		profile: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 96,
				pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
				description: "Profile to activate or create during migration.",
			}),
		),
		description: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
		overwrite: Type.Optional(
			Type.Boolean({ description: "Explicitly replace an existing profile while preserving project bindings." }),
		),
		sources: Type.Optional(
			Type.Array(migrationSourceSchema, {
				minItems: 1,
				maxItems: 64,
				description: "Host-side credential sources. Values are never accepted in tool arguments.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type SecretStoreToolInput = Static<typeof secretStoreSchema>;

export type SecretStoreStatus =
	| "activated"
	| "available"
	| "cancelled"
	| "discovered"
	| "error"
	| "listed"
	| "migrated"
	| "unavailable";

export interface SecretStoreToolDetails {
	action: SecretStoreToolInput["action"];
	status: SecretStoreStatus;
	profile?: string;
	variableNames?: string[];
	profiles?: CredentialProfileSummary[];
	project?: string;
	connected?: boolean;
	sources?: CredentialMigrationSourceCandidate[];
	skipped?: number;
	truncated?: boolean;
	code?: string;
	message?: string;
	sourceRetained?: boolean;
}

export interface SecretStoreToolOptions {
	manager: CredentialManager;
	resolveMigrationSources?: CredentialMigrationSourceResolver;
	discoverMigrationSources?: CredentialMigrationSourceDiscoverer;
}

type SecretStoreResult = {
	content: Array<{ type: "text"; text: string }>;
	details: SecretStoreToolDetails;
};

function result(details: SecretStoreToolDetails, text: string): SecretStoreResult {
	return { content: [{ type: "text", text }], details };
}

function ownerSetupRequired(action: SecretStoreToolInput["action"]): SecretStoreResult {
	const message =
		"No usable machine-owned Bitwarden session was found. TUI needs one owner input: a BW_SESSION key supplied through Pi's masked prompt, never through chat.";
	return result(
		{
			action,
			status: "unavailable",
			...(action === "status" ? { connected: false } : {}),
			code: "owner_setup_required",
			message,
		},
		message,
	);
}

function cancelled(action: SecretStoreToolInput["action"]): SecretStoreResult {
	return result({ action, status: "cancelled", code: "cancelled" }, "Credential action cancelled.");
}

function invalid(input: SecretStoreToolInput): SecretStoreResult | undefined {
	if (input.action === "migrate") {
		if (!input.profile || !input.sources) {
			return result(
				{ action: input.action, status: "error", code: "missing_migration_input" },
				"Credential migration requires a profile and at least one source.",
			);
		}
		return undefined;
	}
	if (input.description !== undefined || input.sources !== undefined || input.overwrite !== undefined) {
		return result(
			{ action: input.action, status: "error", code: "unexpected_migration_input" },
			`Action ${input.action} does not accept migration inputs.`,
		);
	}
	if (input.action !== "activate" && input.profile !== undefined) {
		return result(
			{
				action: input.action,
				status: "error",
				code: "unexpected_profile",
				message: `Action ${input.action} does not accept a profile.`,
			},
			`Secret store request is invalid: action ${input.action} does not accept a profile.`,
		);
	}
	return undefined;
}

function failed(input: SecretStoreToolInput, error: unknown): SecretStoreResult {
	const known =
		error instanceof CredentialManagerError ||
		error instanceof CredentialStorageError ||
		error instanceof CredentialMigrationSourceError ||
		error instanceof CredentialMigrationDiscoveryError;
	const code = known ? error.code : "safe_failure";
	const migrationMessages: Record<string, string> = {
		duplicate_variable: "Credential migration defines the same variable more than once.",
		invalid_source: "Credential migration source data is invalid.",
		source_not_found: "A requested credential source is unavailable.",
		source_unavailable: "A requested credential source could not be read.",
		discovery_cancelled: "Credential discovery was cancelled.",
		discovery_unavailable: "Credential discovery could not inspect the current working tree.",
	};
	const message =
		error instanceof CredentialMigrationSourceError || error instanceof CredentialMigrationDiscoveryError
			? (migrationMessages[error.code] ?? "Credential migration failed safely without exposing values.")
			: known
				? error.message
				: "Credential action failed safely without exposing values.";
	const status: SecretStoreStatus = ["owner_setup_required", "not_connected", "provider_unavailable"].includes(code)
		? "unavailable"
		: "error";
	return result(
		{
			action: input.action,
			status,
			...(input.profile ? { profile: input.profile } : {}),
			code,
			message,
		},
		`Credential action failed: ${message}`,
	);
}

function panelModel(details: SecretStoreToolDetails | undefined, expanded: boolean): OrchestrationPanelModel {
	if (!details) return { label: "secrets", status: "error", emptyText: "No credential result was retained." };
	const success = ["activated", "available", "discovered", "listed", "migrated"].includes(details.status);
	return {
		label: "secrets",
		action: details.status,
		status: success ? "success" : details.status === "cancelled" ? "warning" : "error",
		summary: [
			details.profile,
			details.project,
			details.variableNames
				? `${details.variableNames.length} variable${details.variableNames.length === 1 ? "" : "s"}`
				: undefined,
			details.profiles ? `${details.profiles.length} profile${details.profiles.length === 1 ? "" : "s"}` : undefined,
			details.sources ? `${details.sources.length} source${details.sources.length === 1 ? "" : "s"}` : undefined,
		].filter((value): value is string => value !== undefined),
		rows: expanded
			? details.profiles?.map((profile) => ({
					status: profile.boundToCurrentProject ? ("succeeded" as const) : ("info" as const),
					label: profile.profile,
					meta: [
						`${profile.variableNames.length} variable${profile.variableNames.length === 1 ? "" : "s"}`,
						profile.boundToCurrentProject ? "bound here" : "not bound here",
					],
					details: profile.description ? [profile.description] : undefined,
				}))
			: undefined,
		notices:
			expanded && details.message ? [{ status: success ? "info" : "error", text: details.message }] : undefined,
	};
}

export function createSecretStoreToolDefinition(options: SecretStoreToolOptions) {
	const { manager } = options;
	const resolveSources = options.resolveMigrationSources ?? resolveCredentialMigrationSources;
	const discoverSources = options.discoverMigrationSources ?? discoverCredentialMigrationSources;
	return defineTool<typeof secretStoreSchema, SecretStoreToolDetails>({
		name: "secret_store",
		label: "Secret Store",
		description:
			"Discover, migrate, and activate Bitwarden credential profiles for the current project without exposing values.",
		promptSnippet: "Manage credentials; never expose values.",
		promptGuidelines: [
			"Active user-plane host gate authorizes model-blind migration; never ask duplicate confirmation.",
			"Only when the current task genuinely requires credentials: call secret_store. Never probe or activate for an optional integration; its absence does not block unrelated work.",
			"When required credentials are already on this machine or exact descriptors are unknown, call discover; never ask the owner for source paths or environment-variable names.",
			"Discover names/paths only from bounded project, machine, and environment sources; migrate relevant candidates without exposing values.",
			"Pi tries machine BWS_ACCESS_TOKEN or BW_SESSION first. If both fail, TUI may request one masked BW_SESSION only; never chat.",
			"activate before credential work; TUI/print/RPC return metadata only.",
			"One project binding: omit profile. Multiple: use list, select authorized profile.",
			"Never request credentials in chat/tool arguments.",
			"After activation, run consumer normally; never print/inspect/grep/echo credential environment values.",
			"migrate accepts environment names, dotenv paths, key-file paths; never credential values.",
			"Migration keeps sources. overwrite only for intentional Bitwarden profile replacement.",
			"owner_setup_required without UI: report no usable machine Bitwarden session; never request setup or retry unchanged.",
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
					action: "activating",
					status: "running",
				});
			}
			return new OrchestrationPanelComponent(theme, panelModel(toolResult.details, expanded), expanded);
		},
		async execute(_toolCallId, input, signal, _onUpdate, ctx) {
			if (signal?.aborted) {
				return cancelled(input.action);
			}
			const validation = invalid(input);
			if (validation) return validation;
			try {
				if (input.action === "status") {
					const status = await manager.ensureAvailable(signal);
					return result(
						{ action: input.action, status: "available", connected: status.connected },
						"Bitwarden is connected for this Pi session.",
					);
				}
				if (input.action === "discover") {
					const discovered = await discoverSources(ctx.cwd, signal);
					const count = discovered.candidates.length;
					const notes = [
						discovered.skipped > 0
							? `${discovered.skipped} unreadable or invalid candidate${discovered.skipped === 1 ? " was" : "s were"} skipped.`
							: undefined,
						discovered.truncated ? "The bounded discovery limit was reached." : undefined,
					].filter((note): note is string => note !== undefined);
					return result(
						{
							action: input.action,
							status: "discovered",
							sources: discovered.candidates,
							skipped: discovered.skipped,
							truncated: discovered.truncated,
						},
						`Discovered ${count} credential source${count === 1 ? "" : "s"}; only paths and variable names were returned.${notes.length > 0 ? ` ${notes.join(" ")}` : ""}`,
					);
				}

				const executeCredentialAction = async (): Promise<SecretStoreResult> => {
					if (input.action === "list") {
						const profiles = await manager.listForProject(ctx.cwd, signal);
						return result(
							{ action: input.action, status: "listed", profiles },
							`Found ${profiles.length} credential profile${profiles.length === 1 ? "" : "s"}; only metadata was returned.`,
						);
					}
					if (input.action === "migrate") {
						const { profile, sources } = input;
						if (!profile || !sources) {
							return result(
								{ action: input.action, status: "error", code: "missing_migration_input" },
								"Credential migration requires a profile and at least one source.",
							);
						}
						await manager.prepareForMigration(
							ctx.cwd,
							{ profile, replaceExisting: input.overwrite === true },
							signal,
						);
						let variables = await resolveSources(sources, ctx.cwd, signal);
						try {
							const migrated = await manager.storeVariablesForProject(
								ctx.cwd,
								{
									profile,
									...(input.description ? { description: input.description } : {}),
									variables,
									replaceExisting: input.overwrite === true,
								},
								signal,
							);
							return result(
								{
									action: input.action,
									status: "migrated",
									profile: migrated.profile,
									variableNames: migrated.variableNames,
									project: migrated.project,
									sourceRetained: true,
								},
								`Migrated and activated ${migrated.profile} for ${migrated.project}. Source material was retained.`,
							);
						} finally {
							for (const variable of variables) variable.value = "";
							variables = [];
						}
					}
					const activated = await manager.activateForProject(ctx.cwd, input.profile, signal);
					return result(
						{
							action: input.action,
							status: "activated",
							profile: activated.profile,
							variableNames: activated.variableNames,
							project: activated.project,
						},
						`Activated ${activated.profile} for ${activated.project}. Credential values remain hidden.`,
					);
				};

				const connectWithOwnerKey = async (): Promise<SecretStoreResult | undefined> => {
					if (!ctx.hasUI) return ownerSetupRequired(input.action);
					const connection = await connectCredentialSessionWithMaskedPrompt(manager, ctx.ui, signal);
					return connection === "connected" ? undefined : cancelled(input.action);
				};

				try {
					return await executeCredentialAction();
				} catch (error) {
					if (!isCredentialSessionKeyRequired(error)) throw error;
					const setup = await connectWithOwnerKey();
					if (setup) return setup;
					return await executeCredentialAction();
				}
			} catch (error) {
				return failed(input, error);
			}
		},
	});
}
