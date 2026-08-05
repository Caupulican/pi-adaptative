import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { ORCHESTRATION_THINKING_LEVELS } from "../orchestration/contracts.ts";
import type {
	TaskProfileCreateInput,
	TaskProfileCreateResult,
	TaskProfileInspection,
	TaskProfileWriterPort,
} from "../orchestration/task-profile-writer.ts";

const thinkingLevelSchema = Type.Union(ORCHESTRATION_THINKING_LEVELS.map((level) => Type.Literal(level)));

const budgetSchema = Type.Object(
	{
		maxTokens: Type.Optional(Type.Number({ minimum: 0 })),
		maxWallClockMs: Type.Optional(Type.Number({ minimum: 0 })),
		maxCostUsd: Type.Optional(Type.Number({ minimum: 0 })),
		maxAttempts: Type.Optional(Type.Number({ minimum: 0 })),
		maxToolCalls: Type.Optional(Type.Number({ minimum: 0 })),
		requireApprovalAboveCostUsd: Type.Optional(Type.Number({ minimum: 0 })),
	},
	{ additionalProperties: false },
);

const profileWriterSchema = Type.Union([
	Type.Object({ action: Type.Literal("inspect") }, { additionalProperties: false }),
	Type.Object(
		{
			action: Type.Literal("create"),
			task: Type.String({ minLength: 1, maxLength: 3_500 }),
			baseProfileId: Type.Optional(Type.String({ minLength: 1 })),
			model: Type.Optional(
				Type.Object(
					{
						provider: Type.String({ minLength: 1 }),
						modelId: Type.String({ minLength: 1 }),
						thinkingLevel: thinkingLevelSchema,
					},
					{ additionalProperties: false },
				),
			),
			toolNames: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 64 })),
			resourceProfileNames: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 64 })),
			budget: Type.Optional(budgetSchema),
		},
		{ additionalProperties: false },
	),
]);

export type ProfileWriterToolInput = Static<typeof profileWriterSchema>;

export interface ProfileWriterToolDetails extends TaskProfileCreateResult {
	action: "inspect" | "create";
	inspection?: TaskProfileInspection;
}

export function createProfileWriterToolDefinition(writer: TaskProfileWriterPort): ToolDefinition {
	return {
		name: "profile_writer",
		label: "profile_writer",
		description:
			"Inspect authorized worker bases or create an optional immutable session preset that only narrows a base. Direct delegation does not require a profile.",
		promptSnippet: "Inspect or create an optional session worker preset",
		promptGuidelines: [
			"Use this only when a reusable task-specific preset helps; delegate.authority can select execution directly.",
			"Pass the returned profileId unchanged to delegate; never invent ids or write one-off profile files.",
		],
		parameters: profileWriterSchema,
		execute(_toolCallId, input: ProfileWriterToolInput) {
			if (input.action === "inspect") {
				const inspection = writer.inspectTaskProfileOptions();
				return Promise.resolve({
					content: [
						{
							type: "text" as const,
							text: `Authorized bases: ${inspection.baseProfiles.map((profile) => profile.profileId).join(", ") || "none"}. Available configured models: ${inspection.models.length}.`,
						},
					],
					details: { action: "inspect" as const, created: false, inspection },
				});
			}
			const result = writer.createTaskProfile(input as TaskProfileCreateInput);
			return Promise.resolve({
				content: [
					{
						type: "text" as const,
						text: result.created
							? `Created immutable session task profile ${result.profileId} from ${result.baseProfileId}.`
							: `profile_writer rejected the request: ${result.reason}.`,
					},
				],
				details: { action: "create" as const, ...result },
			});
		},
	};
}
