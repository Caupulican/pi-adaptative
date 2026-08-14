import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { SkillLoadResult, SkillSearchResult, SkillVaultController, SkillVaultStatus } from "../skill-vault.ts";

const skillSchema = Type.Object(
	{
		action: Type.Union(
			[Type.Literal("search"), Type.Literal("load"), Type.Literal("unload"), Type.Literal("status")],
			{ description: "search | load | unload | status" },
		),
		query: Type.Optional(Type.String({ description: "search query" })),
		name: Type.Optional(Type.String({ description: "exact load name" })),
	},
	{ additionalProperties: false },
);

export type SkillToolInput = Static<typeof skillSchema>;
export type SkillToolDetails =
	| { action: "search"; result: SkillSearchResult }
	| { action: "load"; result: SkillLoadResult }
	| { action: "unload"; result: { ok: true; unloaded?: string } }
	| { action: "status"; result: SkillVaultStatus };

function searchText(result: SkillSearchResult): string {
	if (result.candidates.length === 0) return "skill search: no match";
	return result.candidates.map((candidate) => `${candidate.name}: ${candidate.description}`).join("\n");
}

function statusText(result: SkillVaultStatus): string {
	if (result.state === "unloaded") return `skill state: unloaded${result.reason ? `, ${result.reason}` : ""}`;
	if (result.state === "loaded_pending") return `skill state: loaded_pending, ${result.name}, applies next request`;
	return `skill state: active, ${result.name}, idle ${Math.round(result.idleForMs ?? 0)}ms, expires ${Math.round(result.expiresInMs ?? 0)}ms`;
}

/** One compact agent surface over the host-owned skill lifecycle. */
export function createSkillVaultToolDefinition(vault: SkillVaultController): ToolDefinition<typeof skillSchema> {
	return {
		name: "skill",
		label: "Skill",
		toolGroup: "skills",
		description:
			"Skill vault. Specialist guidance useful: search, load exact name before work. Host injects body transiently, expires idle; unload optional.",
		promptSnippet: "Search/load skill.",
		parameters: skillSchema,
		async execute(_toolCallId, input) {
			switch (input.action) {
				case "search": {
					if (!input.query?.trim()) {
						const result: SkillSearchResult = { candidates: [] };
						return {
							content: [{ type: "text" as const, text: "skill search requires query" }],
							details: { action: "search" as const, result },
							isError: true,
						};
					}
					const result = vault.search(input.query);
					return {
						content: [{ type: "text" as const, text: searchText(result) }],
						details: { action: "search" as const, result },
					};
				}
				case "load": {
					const result: SkillLoadResult = input.name?.trim()
						? vault.load(input.name.trim(), "model")
						: { ok: false, reason: "not_found", message: "skill load requires exact name" };
					return {
						content: [
							{
								type: "text" as const,
								text: result.ok
									? `skill loaded: ${result.name}, applies next request`
									: `skill load failed: ${result.message}`,
							},
						],
						details: { action: "load" as const, result },
						isError: !result.ok,
					};
				}
				case "unload": {
					const result = vault.unload();
					return {
						content: [{ type: "text" as const, text: `skill unloaded: ${result.unloaded ?? "none"}` }],
						details: { action: "unload" as const, result },
					};
				}
				case "status": {
					const result = vault.status();
					return {
						content: [{ type: "text" as const, text: statusText(result) }],
						details: { action: "status" as const, result },
					};
				}
			}
		},
	};
}
