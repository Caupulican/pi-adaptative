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
	emptyOrchestrationCall,
	OrchestrationPanelComponent,
	type OrchestrationPanelModel,
} from "./orchestration-panel.ts";

const secretStoreSchema = Type.Object(
	{
		action: Type.Union([Type.Literal("status"), Type.Literal("list"), Type.Literal("activate")], {
			description: "Credential-use action. Credential mutation is owner-only through /secrets.",
		}),
		profile: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 96,
				pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
				description: "Bound profile to activate. Omit when the project has exactly one bound profile.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type SecretStoreToolInput = Static<typeof secretStoreSchema>;

export type SecretStoreStatus = "activated" | "available" | "cancelled" | "error" | "listed" | "unavailable";

export interface SecretStoreToolDetails {
	action: SecretStoreToolInput["action"];
	status: SecretStoreStatus;
	profile?: string;
	variableNames?: string[];
	profiles?: CredentialProfileSummary[];
	project?: string;
	connected?: boolean;
	code?: string;
	message?: string;
}

export interface SecretStoreToolOptions {
	manager: CredentialManager;
}

type SecretStoreResult = {
	content: Array<{ type: "text"; text: string }>;
	details: SecretStoreToolDetails;
};

function result(details: SecretStoreToolDetails, text: string): SecretStoreResult {
	return { content: [{ type: "text", text }], details };
}

function invalid(input: SecretStoreToolInput): SecretStoreResult | undefined {
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
	const known = error instanceof CredentialManagerError || error instanceof CredentialStorageError;
	const code = known ? error.code : "safe_failure";
	const message = known ? error.message : "Credential activation failed safely without exposing values.";
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
	const success = ["activated", "available", "listed"].includes(details.status);
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
	return defineTool<typeof secretStoreSchema, SecretStoreToolDetails>({
		name: "secret_store",
		label: "Secret Store",
		description:
			"Discover and activate owner-authorized Bitwarden credential profiles for the current project without exposing values.",
		promptSnippet:
			"Activate project credentials with secret_store before credential-dependent commands. Credential setup and mutation are owner-only through /secrets.",
		promptGuidelines: [
			"Use secret_store activate before credential-dependent work. It works in TUI, print, and RPC modes and returns metadata only.",
			"Omit profile when the project has one binding. Use list to select among multiple authorized profiles.",
			"Never ask the owner to paste a credential into chat or pass a value through tool arguments.",
			"After activation, run the consuming command normally. Never print, inspect, grep, or echo credential environment values.",
			"If owner_setup_required is returned, tell the owner to run /secrets in a TUI session. Do not repeatedly retry.",
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
				return result(
					{ action: input.action, status: "cancelled", code: "cancelled" },
					"Credential action cancelled.",
				);
			}
			const validation = invalid(input);
			if (validation) return validation;
			try {
				if (input.action === "status") {
					const status = manager.status;
					if (!status.sessionAvailable) {
						return result(
							{
								action: input.action,
								status: "unavailable",
								connected: false,
								code: "owner_setup_required",
								message: "The owner must connect Bitwarden with /secrets.",
							},
							"Bitwarden owner setup is required. Run /secrets in a TUI session.",
						);
					}
					return result(
						{ action: input.action, status: "available", connected: status.connected },
						status.connected
							? "Bitwarden is connected for this Pi session."
							: "A Bitwarden session key is available and will be validated on activation.",
					);
				}
				if (input.action === "list") {
					const profiles = await manager.listForProject(ctx.cwd, signal);
					return result(
						{ action: input.action, status: "listed", profiles },
						`Found ${profiles.length} credential profile${profiles.length === 1 ? "" : "s"}; only metadata was returned.`,
					);
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
			} catch (error) {
				return failed(input, error);
			}
		},
	});
}
