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
		name: Type.Optional(Type.String({ description: "exact skill name; unload without it unloads all" })),
		pin: Type.Optional(Type.Boolean({ description: "protect from eviction while loaded; max 2" })),
	},
	{ additionalProperties: false },
);

export type SkillToolInput = Static<typeof skillSchema>;
export type SkillToolDetails =
	| { action: "search"; result: SkillSearchResult }
	| { action: "load"; result: SkillLoadResult }
	| { action: "unload"; result: { ok: true; unloaded: string[] } }
	| { action: "status"; result: SkillVaultStatus };

function searchText(result: SkillSearchResult): string {
	if (result.candidates.length === 0) return "skill search: no match";
	return result.candidates.map((candidate) => `${candidate.name}: ${candidate.description}`).join("\n");
}

function loadText(result: Extract<SkillLoadResult, { ok: true }>): string {
	const pin = result.pinned ? " (pinned)" : "";
	const evicted = result.evicted ? `; EVICTED: ${result.evicted.join(", ")}` : "";
	return `skill loaded_pending: ${result.name}${pin} (base ${result.baseDir}), activates next request; expires when idle${evicted}`;
}

function statusText(result: SkillVaultStatus): string {
	if (result.slots.length === 0) return `skill state: unloaded${result.reason ? `, ${result.reason}` : ""}`;
	return result.slots
		.map((slot) => {
			const pin = slot.pinned ? " (pinned)" : "";
			return slot.state === "loaded_pending"
				? `skill state: loaded_pending, ${slot.name}${pin}, activates next request`
				: `skill state: active, ${slot.name}${pin}, idle ${Math.round(slot.idleForMs ?? 0)}ms, expires ${Math.round(slot.expiresInMs ?? 0)}ms`;
		})
		.join("\n");
}

/** One compact agent surface over the host-owned skill lifecycle. */
export function createSkillVaultToolDefinition(vault: SkillVaultController): ToolDefinition<typeof skillSchema> {
	return {
		name: "skill",
		label: "Skill",
		description:
			"Skill vault, up to 3 concurrent skills under one byte budget. Specialist guidance useful: search, load exact name before work. Load may evict the oldest-loaded unpinned skill and reports it; pin protects up to 2 task-critical skills from eviction (they still expire idle). Host injects bodies transiently starting next request, expires idle; unload one name or all.",
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
						? vault.load(input.name.trim(), "model", input.pin === true)
						: { ok: false, reason: "not_found", message: "skill load requires exact name" };
					return {
						content: [
							{
								type: "text" as const,
								text: result.ok ? loadText(result) : `skill load failed: ${result.message}`,
							},
						],
						details: { action: "load" as const, result },
						isError: !result.ok,
					};
				}
				case "unload": {
					const result = vault.unload(input.name?.trim() || undefined);
					return {
						content: [
							{
								type: "text" as const,
								text: `skill unloaded: ${result.unloaded.length > 0 ? result.unloaded.join(", ") : "none"}`,
							},
						],
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
