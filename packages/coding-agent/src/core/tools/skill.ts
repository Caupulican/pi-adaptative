import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type {
	SkillLoadResult,
	SkillReadResult,
	SkillSearchResult,
	SkillVaultController,
	SkillVaultStatus,
} from "../skill-vault.ts";

const skillSchema = Type.Object(
	{
		action: Type.Union(
			[Type.Literal("search"), Type.Literal("load"), Type.Literal("unload"), Type.Literal("status")],
			{ description: "search | load | unload | status" },
		),
		query: Type.Optional(Type.String({ description: "search query" })),
		name: Type.Optional(Type.String({ description: "exact skill name; unload without it unloads all" })),
		names: Type.Optional(
			Type.Array(Type.String({ minLength: 1 }), {
				minItems: 1,
				maxItems: 8,
				description: "several exact skill names to load in ONE call, in order; prefer this over one call per skill",
			}),
		),
		pin: Type.Optional(Type.Boolean({ description: "protect from eviction while loaded; max 2" })),
	},
	{ additionalProperties: false },
);

export type SkillToolInput = Static<typeof skillSchema>;
export type SkillToolDetails =
	| { action: "search"; result: SkillSearchResult }
	| { action: "load"; result: SkillLoadResult; results?: SkillLoadResult[] }
	| { action: "unload"; result: { ok: true; unloaded: string[] } }
	| { action: "status"; result: SkillVaultStatus };

export interface ReadOnlySkillBroker {
	search(query: string): SkillSearchResult;
	read(name: string): SkillReadResult;
}

const readOnlySkillSchema = Type.Object(
	{
		action: Type.Union([Type.Literal("search"), Type.Literal("read")], { description: "search | read" }),
		query: Type.Optional(Type.String({ description: "search query" })),
		name: Type.Optional(Type.String({ description: "exact skill name" })),
	},
	{ additionalProperties: false },
);

function readText(result: Extract<SkillReadResult, { ok: true }>): string {
	return `skill: ${result.name}\n${result.description}\n\n${result.body}`;
}

/** Worker-only read/search surface; it cannot load, unload, pin, or inspect vault slots. */
export function createReadOnlySkillToolDefinition(
	broker: ReadOnlySkillBroker,
): ToolDefinition<typeof readOnlySkillSchema> {
	return {
		name: "skill",
		label: "Skill (read-only)",
		description:
			"Search and read eligible skill guidance through a bounded host broker. This worker surface cannot mutate the skill vault.",
		promptSnippet: "Search/read skill guidance.",
		parameters: readOnlySkillSchema,
		async execute(_toolCallId, input) {
			if (input.action === "search") {
				if (!input.query?.trim()) {
					return {
						content: [{ type: "text" as const, text: "skill search requires query" }],
						details: { action: "search", result: { candidates: [] } },
						isError: true,
					};
				}
				const result = broker.search(input.query);
				return {
					content: [{ type: "text" as const, text: searchText(result) }],
					details: { action: "search", result },
				};
			}
			if (!input.name?.trim()) {
				return {
					content: [{ type: "text" as const, text: "skill read requires exact name" }],
					details: {
						action: "read",
						result: { ok: false, reason: "not_found", message: "Skill name is required." },
					},
					isError: true,
				};
			}
			const result = broker.read(input.name.trim());
			return {
				content: [
					{ type: "text" as const, text: result.ok ? readText(result) : `skill read failed: ${result.message}` },
				],
				details: { action: "read", result },
				...(result.ok ? {} : { isError: true }),
			};
		},
	};
}

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
					const names = [...(input.names ?? []), ...(input.name ? [input.name] : [])]
						.map((name) => name.trim())
						.filter((name, index, all) => name.length > 0 && all.indexOf(name) === index);
					if (names.length === 0) {
						const result: SkillLoadResult = {
							ok: false,
							reason: "not_found",
							message: "skill load requires an exact name",
						};
						return {
							content: [{ type: "text" as const, text: `skill load failed: ${result.message}` }],
							details: { action: "load" as const, result },
							isError: true,
						};
					}
					// Several names load in order through the same vault call each; one round trip instead of
					// one per skill, with every outcome reported.
					const results = names.map((name) => vault.load(name, "model", input.pin === true));
					const lines = results.map((result) =>
						result.ok ? loadText(result) : `skill load failed: ${result.message}`,
					);
					const last = results[results.length - 1]!;
					return {
						content: [{ type: "text" as const, text: lines.join("\n") }],
						details: { action: "load" as const, result: last, ...(results.length > 1 ? { results } : {}) },
						isError: results.some((result) => !result.ok),
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
