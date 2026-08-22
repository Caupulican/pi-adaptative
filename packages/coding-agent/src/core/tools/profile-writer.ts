import { Type } from "typebox";
import { MAX_ORCHESTRATION_IDENTIFIER_LENGTH } from "../orchestration/contracts.ts";
import type {
	TaskProfileCreateInput,
	TaskProfileCreateResult,
	TaskProfileInspection,
	TaskProfileWriterPort,
} from "../orchestration/task-profile-writer.ts";
import type { OrchestrationPanelModel } from "./orchestration-panel.ts";

export const DELEGATE_PROFILE_ACTIONS = ["profile_inspect", "profile_create"] as const;

export type DelegateProfileAction = (typeof DELEGATE_PROFILE_ACTIONS)[number];

export interface DelegateProfileInput {
	task?: string;
	baseProfileId?: string;
	model?: TaskProfileCreateInput["model"];
	thinkingLevel?: TaskProfileCreateInput["thinkingLevel"];
	path?: string;
	toolNames?: readonly string[];
}

export interface DelegateProfileToolDetails extends TaskProfileCreateResult {
	started: boolean;
	action: DelegateProfileAction;
	kind: "profile";
	inspection?: TaskProfileInspection;
}

export function createDelegateProfileParameterSchemas() {
	return {
		task: Type.Optional(Type.String({ minLength: 1, maxLength: 3_500 })),
		baseProfileId: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_ORCHESTRATION_IDENTIFIER_LENGTH })),
	};
}

export function delegateProfilePanelModel(details: DelegateProfileToolDetails): OrchestrationPanelModel {
	if (details.action === "profile_inspect") {
		return {
			label: "worker profiles",
			action: "inspected",
			status: "success",
			summary: [
				`${details.inspection?.baseProfiles.length ?? 0} bases`,
				`${details.inspection?.models.length ?? 0} models`,
			],
		};
	}
	return {
		label: "worker profiles",
		action: details.created ? "created" : "rejected",
		status: details.created ? "success" : "warning",
		rows: details.profileId
			? [
					{
						status: "succeeded",
						label: details.profileId,
						meta: details.baseProfileId ? [`base ${details.baseProfileId}`] : undefined,
					},
				]
			: undefined,
		emptyText: details.reason,
	};
}

export function formatTaskProfileInspection(inspection: TaskProfileInspection): string {
	const bases = inspection.baseProfiles.map((profile) => profile.profileId).join(", ") || "none";
	const inheritedTools = inspection.inheritedToolNames.join(", ") || "none";
	return `Optional owner-authored bases for profile_create: ${bases}. Omit baseProfileId to derive the foreground model, reasoning, compatible tools, and machine scope. Effective inherited native tools: ${inheritedTools}. Optional model, thinkingLevel, path, and toolNames fields narrow that inherited base. Available configured models: ${inspection.models.length}.`;
}

export function executeDelegateProfileAction(
	action: DelegateProfileAction,
	input: DelegateProfileInput,
	writer: TaskProfileWriterPort,
): { content: Array<{ type: "text"; text: string }>; details: DelegateProfileToolDetails } {
	if (action === "profile_inspect") {
		const inspection = writer.inspectTaskProfileOptions();
		return {
			content: [
				{
					type: "text",
					text: formatTaskProfileInspection(inspection),
				},
			],
			details: { started: true, action, kind: "profile", created: false, inspection },
		};
	}

	if (input.task === undefined) {
		return {
			content: [{ type: "text", text: "delegate profile_create requires task" }],
			details: {
				started: false,
				action,
				kind: "profile",
				created: false,
				reason: "missing_profile_task",
			},
		};
	}
	const request: TaskProfileCreateInput = {
		task: input.task,
		...(input.baseProfileId !== undefined ? { baseProfileId: input.baseProfileId } : {}),
		...(input.model !== undefined ? { model: input.model } : {}),
		...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
		...(input.path !== undefined ? { path: input.path } : {}),
		...(input.toolNames !== undefined ? { toolNames: input.toolNames } : {}),
	};
	const result = writer.createTaskProfile(request);
	return {
		content: [
			{
				type: "text",
				text: result.created
					? `Created immutable session task profile ${result.profileId} from ${result.baseProfileId ?? "foreground inheritance"}.`
					: `delegate profile_create rejected the request: ${result.reason}.`,
			},
		],
		details: { started: result.created, action, kind: "profile", ...result },
	};
}
