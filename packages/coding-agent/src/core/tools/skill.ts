import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { checkSkillEvolutionEligibility } from "../session-skill-policy.ts";
import type { SettingsManager } from "../settings-manager.ts";
import {
	MAX_LOADED_SKILLS,
	MAX_PINNED_SKILLS,
	type SkillExcludeResult,
	type SkillInspectResult,
	type SkillLoadResult,
	type SkillReadResult,
	type SkillRepairResult,
	type SkillSearchResult,
	type SkillVaultController,
	type SkillVaultStatus,
} from "../skill-vault.ts";

const skillSchema = Type.Object(
	{
		action: Type.Union(
			[
				Type.Literal("search"),
				Type.Literal("load"),
				Type.Literal("unload"),
				Type.Literal("status"),
				Type.Literal("exclude"),
				Type.Literal("inspect"),
				Type.Literal("repair"),
			],
			{ description: "search | load | unload | status | exclude | inspect | repair" },
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
		reason: Type.Optional(
			Type.String({
				description: "exact explanation of conflict with owner instructions (required for exclude)",
			}),
		),
		body: Type.Optional(
			Type.String({
				description: "repaired markdown body without frontmatter (required for repair)",
			}),
		),
		description: Type.Optional(
			Type.String({
				description: "optional replacement description for repair",
			}),
		),
		expectedVersion: Type.Optional(
			Type.String({
				description: "expected source version token from inspect (required for repair)",
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
	| { action: "status"; result: SkillVaultStatus }
	| { action: "exclude"; result: SkillExcludeResult; evolution?: { eligible: boolean; reason: string } }
	| { action: "inspect"; result: SkillInspectResult }
	| { action: "repair"; result: SkillRepairResult };

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
			"Search and read eligible skill guidance through a bounded host broker. This worker surface cannot mutate the skill vault. When a skill conflicts with owner instructions, report the conflicting skill to the parent rather than pausing on an approval latch.",
		promptSnippet: "Search/read skill guidance; report conflicts to parent.",
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
	const lines: string[] = [];
	if (result.slots.length === 0) {
		lines.push(`skill state: unloaded${result.reason ? `, ${result.reason}` : ""}`);
	} else {
		for (const slot of result.slots) {
			const pin = slot.pinned ? " (pinned)" : "";
			lines.push(
				slot.state === "loaded_pending"
					? `skill state: loaded_pending, ${slot.name}${pin}, activates next request`
					: `skill state: active, ${slot.name}${pin}, idle ${Math.round(slot.idleForMs ?? 0)}ms, expires ${Math.round(slot.expiresInMs ?? 0)}ms`,
			);
		}
	}
	if (result.exclusions && result.exclusions.length > 0) {
		lines.push("exclusions (conflict with owner instructions):");
		for (const exclusion of result.exclusions) {
			lines.push(`- ${exclusion.name}: ${exclusion.reason}`);
		}
	}
	return lines.join("\n");
}

export interface SkillVaultToolOptions {
	getSettingsManager?: () => SettingsManager | undefined;
}

/** One compact agent surface over the host-owned skill lifecycle. */
export function createSkillVaultToolDefinition(
	vault: SkillVaultController,
	options?: SkillVaultToolOptions,
): ToolDefinition<typeof skillSchema> {
	return {
		name: "skill",
		label: "Skill",
		description: `Skill vault, up to ${MAX_LOADED_SKILLS} concurrent skills under one byte budget. Search, then load exact names before work. A batch loads every requested skill or rejects without partial admission. Load may evict previously loaded skills and reports them, preferring the oldest unpinned. Pin prioritizes retention; pinned skills still expire idle. Host injects bodies starting next request; unload one name or all. On detecting a loaded or available skill conflicts with owner instructions: invoke skill exclude with exact name and reason immediately (unloads skill and excludes from session skill mapping), continue authorized work; optional repair only if configured eligible.`,
		promptSnippet: "Search/load/exclude skill. Exclude immediately on conflict with owner instructions.",
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
				case "exclude": {
					if (!input.name?.trim()) {
						return {
							content: [{ type: "text" as const, text: "skill exclude requires exact name" }],
							details: {
								action: "exclude" as const,
								result: { ok: false, reason: "invalid_name", message: "Skill exclude requires an exact name." },
							},
							isError: true,
						};
					}
					if (!input.reason?.trim()) {
						return {
							content: [
								{
									type: "text" as const,
									text: "skill exclude requires reason explaining conflict with owner instructions",
								},
							],
							details: {
								action: "exclude" as const,
								result: {
									ok: false,
									reason: "invalid_reason",
									message: "Skill exclude requires a reason explaining conflict with owner instructions.",
								},
							},
							isError: true,
						};
					}
					const result = vault.exclude(input.name.trim(), input.reason.trim());
					let evolution: { eligible: boolean; reason: string } | undefined;
					const settingsManager = options?.getSettingsManager?.();
					if (settingsManager) {
						const autonomyMode = settingsManager.getAutonomySettings().mode;
						const autoLearn = settingsManager.getAutoLearnSettings();
						evolution = checkSkillEvolutionEligibility(autonomyMode, autoLearn);
					}
					if (!result.ok) {
						return {
							content: [{ type: "text" as const, text: `skill exclude failed: ${result.message}` }],
							details: { action: "exclude" as const, result, ...(evolution ? { evolution } : {}) },
							isError: true,
						};
					}
					const already = result.alreadyExcluded ? " (already excluded)" : "";
					const evoText = evolution
						? `\nSkill evolution: ${evolution.eligible ? "eligible" : "ineligible"} (${evolution.reason}).`
						: "";
					return {
						content: [
							{
								type: "text" as const,
								text: `skill excluded${already}: ${result.name} (${result.reason}). Unloaded and excluded from this session.${evoText}`,
							},
						],
						details: { action: "exclude" as const, result, ...(evolution ? { evolution } : {}) },
					};
				}
				case "inspect": {
					if (!input.name?.trim()) {
						return {
							content: [{ type: "text" as const, text: "skill inspect requires exact name" }],
							details: {
								action: "inspect" as const,
								result: { ok: false, reason: "not_found", message: "Skill inspect requires an exact name." },
							},
							isError: true,
						};
					}
					const result = vault.inspect(input.name.trim());
					if (!result.ok) {
						return {
							content: [{ type: "text" as const, text: `skill inspect failed: ${result.message}` }],
							details: { action: "inspect" as const, result },
							isError: true,
						};
					}
					const excludedNote = vault.isExcluded(result.name) ? " [EXCLUDED in this session]" : "";
					return {
						content: [
							{
								type: "text" as const,
								text: `skill: ${result.name} (version ${result.version})${excludedNote}\n${result.description}\n\n${result.body}`,
							},
						],
						details: { action: "inspect" as const, result },
					};
				}
				case "repair": {
					if (!input.name?.trim()) {
						return {
							content: [{ type: "text" as const, text: "skill repair requires exact name" }],
							details: {
								action: "repair" as const,
								result: { ok: false, reason: "not_found", message: "Skill repair requires an exact name." },
							},
							isError: true,
						};
					}
					if (!input.body?.trim()) {
						return {
							content: [{ type: "text" as const, text: "skill repair requires repaired body content" }],
							details: {
								action: "repair" as const,
								result: { ok: false, reason: "invalid_body", message: "Skill repair requires body content." },
							},
							isError: true,
						};
					}
					const settingsManager = options?.getSettingsManager?.();
					const autonomyMode = settingsManager?.getAutonomySettings().mode ?? "off";
					const autoLearn = settingsManager?.getAutoLearnSettings();
					const evolution = checkSkillEvolutionEligibility(autonomyMode, autoLearn);
					if (!evolution.eligible) {
						return {
							content: [
								{
									type: "text" as const,
									text: `skill repair rejected: skill evolution is not permitted (${evolution.reason})`,
								},
							],
							details: {
								action: "repair" as const,
								result: {
									ok: false,
									reason: "write_failed",
									message: `Skill evolution is not permitted: ${evolution.reason}`,
								},
							},
							isError: true,
						};
					}
					if (!input.expectedVersion?.trim()) {
						return {
							content: [{ type: "text" as const, text: "skill repair requires expectedVersion from inspect" }],
							details: {
								action: "repair" as const,
								result: {
									ok: false,
									reason: "stale_source",
									message: "Skill repair requires expectedVersion from inspect.",
								},
							},
							isError: true,
						};
					}
					const result = vault.repairSkill({
						name: input.name.trim(),
						body: input.body,
						expectedVersion: input.expectedVersion.trim(),
						description: input.description?.trim(),
					});
					if (!result.ok) {
						return {
							content: [{ type: "text" as const, text: `skill repair failed: ${result.message}` }],
							details: { action: "repair" as const, result },
							isError: true,
						};
					}
					const isCurrentlyExcluded = vault.isExcluded(result.name);
					const exclusionNote = isCurrentlyExcluded ? " Note: skill remains excluded in this session." : "";
					return {
						content: [
							{
								type: "text" as const,
								text: `skill repaired: ${result.name} (version ${result.version}) on disk at ${result.filePath}.${exclusionNote}`,
							},
						],
						details: { action: "repair" as const, result },
					};
				}
			}
		},
	};
}
