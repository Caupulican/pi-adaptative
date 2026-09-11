import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import {
	MAX_LOADED_SKILLS,
	MAX_PINNED_SKILLS,
	type SkillLoadResult,
	type SkillReadResult,
	type SkillSearchResult,
	type SkillVaultController,
	type SkillVaultStatus,
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
				maxItems: MAX_LOADED_SKILLS,
				description: "exact skill names to load together in ONE atomic call; the complete set must fit the vault",
			}),
		),
		pin: Type.Optional(
			Type.Boolean({
				description: `prioritize retention while loaded; at most ${MAX_PINNED_SKILLS} pins, further requests load unpinned`,
			}),
		),
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
	const lines =
		result.candidates.length === 0
			? ["skill search: no match"]
			: result.candidates.map((candidate) => `${candidate.name}: ${candidate.description}`);
	// A skill the loader could not index is otherwise invisible; naming it here is what lets the
	// model (or the owner) fix the SKILL.md instead of retrying a name that will never load.
	for (const diagnostic of result.diagnostics ?? []) lines.push(`skipped ${diagnostic}`);
	return lines.join("\n");
}

function loadText(result: Extract<SkillLoadResult, { ok: true }>): string {
	const pin = result.pinned
		? " (pinned)"
		: result.pinCapReached
			? ` (not pinned: ${MAX_PINNED_SKILLS} pins already held; unload a pinned skill to pin this one)`
			: "";
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
		description: `Skill vault, up to ${MAX_LOADED_SKILLS} concurrent skills under one byte budget. Search, then load exact names before work. A batch loads every requested skill or rejects without partial admission. Load may evict previously loaded skills and reports them, preferring the oldest unpinned. Pin prioritizes retention; pinned skills still expire idle. Host injects bodies starting next request; unload one name or all.`,
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
					const result = vault.loadMany(
						[...(input.names ?? []), ...(input.name ? [input.name] : [])],
						"model",
						input.pin === true,
					);
					if (!result.ok) {
						return {
							content: [{ type: "text" as const, text: `skill load failed: ${result.message}` }],
							details: { action: "load" as const, result },
							isError: true,
						};
					}
					const results = result.results;
					const lines = results.map(loadText);
					const last = results[results.length - 1]!;
					return {
						content: [{ type: "text" as const, text: lines.join("\n") }],
						details: { action: "load" as const, result: last, ...(results.length > 1 ? { results } : {}) },
						isError: false,
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
