import { describe, expect, it } from "vitest";
import { createInMemoryArtifactStore } from "../src/core/context/context-artifacts.ts";
import { runContextAudit } from "../src/core/context/context-audit.ts";
import {
	CONTEXT_VISIBILITY_PROJECTION_CUSTOM_TYPE,
	type ContextPromptEnforcementSettings,
	enforcePromptPolicy,
} from "../src/core/context/context-prompt-enforcement.ts";
import { type PromptPolicyShadowReport, planPromptPolicy } from "../src/core/context/context-prompt-policy.ts";

function toolResultMessage(overrides: {
	toolCallId: string;
	toolName?: string;
	text?: string;
	artifactId?: string;
	isError?: boolean;
	extraDetails?: Record<string, unknown>;
}) {
	return {
		role: "toolResult" as const,
		toolCallId: overrides.toolCallId,
		toolName: overrides.toolName ?? "grep",
		content: [{ type: "text" as const, text: overrides.text ?? "some tool output" }],
		details:
			overrides.artifactId || overrides.extraDetails
				? { ...(overrides.artifactId ? { artifactId: overrides.artifactId } : {}), ...overrides.extraDetails }
				: undefined,
		isError: overrides.isError ?? false,
		timestamp: 0,
	};
}

function settings(overrides: Partial<ContextPromptEnforcementSettings> = {}): ContextPromptEnforcementSettings {
	return { enabled: true, preserveRecentMessages: 2, minChars: 10, retrievalToolAvailable: true, ...overrides };
}

const BIG = "x".repeat(20_000);

describe("enforcePromptPolicy: disabled", () => {
	it("returns the same messages reference and an empty report when disabled", () => {
		const store = createInMemoryArtifactStore();
		const { ref } = store.write({
			kind: "tool_output",
			content: BIG,
			toolName: "grep",
			createdAtTurn: 0,
			reproducible: true,
		});
		const messages = [
			toolResultMessage({ toolCallId: "tc-1", artifactId: ref.id }),
			toolResultMessage({ toolCallId: "tc-2" }),
		];
		const audit = runContextAudit(messages, { turnIndex: 0, artifactStore: store });
		const plan = planPromptPolicy(audit);

		const result = enforcePromptPolicy(messages, plan, settings({ enabled: false }));

		expect(result.messages).toBe(messages);
		expect(result.report.items).toEqual([]);
	});
});

describe("enforcePromptPolicy: enabled, artifact-backed eligible stale item", () => {
	it("stubs the message in place and reports the action", () => {
		const store = createInMemoryArtifactStore();
		const { ref } = store.write({
			kind: "tool_output",
			content: BIG,
			toolName: "grep",
			createdAtTurn: 0,
			reproducible: true,
		});
		// 3 plain messages after the grep result pushes it outside preserveRecentMessages:2.
		const messages = [
			toolResultMessage({ toolCallId: "tc-1", artifactId: ref.id, text: BIG }),
			toolResultMessage({ toolCallId: "tc-2" }),
			toolResultMessage({ toolCallId: "tc-3" }),
			toolResultMessage({ toolCallId: "tc-4" }),
		];
		const audit = runContextAudit(messages, { turnIndex: 0, artifactStore: store });
		const plan = planPromptPolicy(audit);

		const result = enforcePromptPolicy(messages, plan, settings());

		expect(result.messages).not.toBe(messages);
		const stubbed = result.messages[0];
		expect(stubbed.role).toBe("toolResult");
		if (stubbed.role === "toolResult") {
			expect(stubbed.content).toEqual([
				{
					type: "text",
					text: `[content replaced by prompt-policy: originally ${BIG.length} chars from a stale grep tool result. Retrieve the full output with artifact_retrieve using artifactId "${ref.id}".]`,
				},
			]);
			expect(
				(stubbed.details as { promptPolicy?: { enforced?: boolean; artifactId?: string } }).promptPolicy,
			).toEqual({
				enforced: true,
				action: "artifact_stub",
				artifactId: ref.id,
				originalChars: BIG.length,
				reason: "stale_artifact_backed_tool_output",
				selectedVisibility: "hidden",
				visibilityReason: "legacy_stale",
			});
			// The original artifactId field is preserved alongside the new promptPolicy marker.
			expect((stubbed.details as { artifactId?: string }).artifactId).toBe(ref.id);
		}

		const [entry] = result.report.items;
		expect(entry.enforced).toBe(true);
		expect(entry.action).toBe("artifact_stub");
		expect(entry.artifactId).toBe(ref.id);
	});

	it("does not mutate the input messages array or its objects", () => {
		const store = createInMemoryArtifactStore();
		const { ref } = store.write({
			kind: "tool_output",
			content: BIG,
			toolName: "grep",
			createdAtTurn: 0,
			reproducible: true,
		});
		const messages = [
			toolResultMessage({ toolCallId: "tc-1", artifactId: ref.id, text: BIG }),
			toolResultMessage({ toolCallId: "tc-2" }),
			toolResultMessage({ toolCallId: "tc-3" }),
			toolResultMessage({ toolCallId: "tc-4" }),
		];
		const snapshot = JSON.parse(JSON.stringify(messages));
		const audit = runContextAudit(messages, { turnIndex: 0, artifactStore: store });
		const plan = planPromptPolicy(audit);

		enforcePromptPolicy(messages, plan, settings());

		expect(JSON.parse(JSON.stringify(messages))).toEqual(snapshot);
	});
});

describe("enforcePromptPolicy: conservative skip conditions", () => {
	it("leaves a non-artifact (transcript-only) item unchanged: missing retrieval path", () => {
		const messages = [
			toolResultMessage({ toolCallId: "tc-1", toolName: "read", text: BIG }),
			toolResultMessage({ toolCallId: "tc-2" }),
			toolResultMessage({ toolCallId: "tc-3" }),
			toolResultMessage({ toolCallId: "tc-4" }),
		];
		const audit = runContextAudit(messages, { turnIndex: 0, sessionEntryIdForToolCallId: () => "entry-1" });
		const plan = planPromptPolicy(audit);

		const result = enforcePromptPolicy(messages, plan, settings());

		expect(result.messages).toBe(messages);
		expect(result.report.items[0]?.skipReason).toBe("not_artifact_backed");
	});

	it("leaves a recent/current-tail item unchanged even if it is artifact-backed and stale-sized", () => {
		const store = createInMemoryArtifactStore();
		const { ref } = store.write({
			kind: "tool_output",
			content: BIG,
			toolName: "grep",
			createdAtTurn: 0,
			reproducible: true,
		});
		// Only 1 message: index 0 is within preserveRecentMessages:2's window (recentCutoff = max(0, 1-2) = 0).
		const messages = [toolResultMessage({ toolCallId: "tc-1", artifactId: ref.id, text: BIG })];
		const audit = runContextAudit(messages, { turnIndex: 0, artifactStore: store });
		const plan = planPromptPolicy(audit);

		const result = enforcePromptPolicy(messages, plan, settings());

		expect(result.messages).toBe(messages);
		expect(result.report.items[0]?.skipReason).toBe("within_recent_window");
	});

	it("leaves an errored tool result unchanged", () => {
		const store = createInMemoryArtifactStore();
		const { ref } = store.write({
			kind: "tool_output",
			content: BIG,
			toolName: "grep",
			createdAtTurn: 0,
			reproducible: true,
		});
		const messages = [
			toolResultMessage({ toolCallId: "tc-1", artifactId: ref.id, text: BIG, isError: true }),
			toolResultMessage({ toolCallId: "tc-2" }),
			toolResultMessage({ toolCallId: "tc-3" }),
			toolResultMessage({ toolCallId: "tc-4" }),
		];
		const audit = runContextAudit(messages, { turnIndex: 0, artifactStore: store });
		const plan = planPromptPolicy(audit);

		const result = enforcePromptPolicy(messages, plan, settings());

		expect(result.messages).toBe(messages);
		expect(result.report.items[0]?.skipReason).toBe("errored_tool_result");
	});

	it("leaves an already-stubbed or already-gc-packed item unchanged", () => {
		const store = createInMemoryArtifactStore();
		const { ref } = store.write({
			kind: "tool_output",
			content: BIG,
			toolName: "grep",
			createdAtTurn: 0,
			reproducible: true,
		});
		const messages = [
			toolResultMessage({
				toolCallId: "tc-1",
				artifactId: ref.id,
				text: BIG,
				extraDetails: { contextGc: { packed: true } },
			}),
			toolResultMessage({ toolCallId: "tc-2" }),
			toolResultMessage({ toolCallId: "tc-3" }),
			toolResultMessage({ toolCallId: "tc-4" }),
		];
		const audit = runContextAudit(messages, { turnIndex: 0, artifactStore: store });
		const plan = planPromptPolicy(audit);

		const result = enforcePromptPolicy(messages, plan, settings());

		expect(result.messages).toBe(messages);
		expect(result.report.items[0]?.skipReason).toBe("already_stubbed_or_packed");
	});

	it("projects query-relevant evidence at the request tail when GC already owns the stable prefix", () => {
		const store = createInMemoryArtifactStore();
		const { ref } = store.write({
			kind: "tool_output",
			content: BIG,
			toolName: "grep",
			createdAtTurn: 0,
			reproducible: true,
		});
		const sourceMessages = [
			toolResultMessage({ toolCallId: "tc-1", artifactId: ref.id, text: BIG }),
			toolResultMessage({ toolCallId: "tc-2" }),
			toolResultMessage({ toolCallId: "tc-3" }),
			toolResultMessage({ toolCallId: "tc-4" }),
		];
		const audit = runContextAudit(sourceMessages, { turnIndex: 0, artifactStore: store });
		const plan = planPromptPolicy(audit);
		const packedMessages = sourceMessages.slice();
		packedMessages[0] = toolResultMessage({
			toolCallId: "tc-1",
			artifactId: ref.id,
			text: "[Context GC packed stale tool result]",
			extraDetails: { contextGc: { packed: true } },
		});

		const result = enforcePromptPolicy(
			packedMessages,
			plan,
			settings({ brainRelevance: () => ({ relevant: true, confidence: 0.99 }) }),
			{
				sourceMessages,
				frozenBelow: 1,
				gcReport: {
					enabled: true,
					packedCount: 1,
					originalTokens: 5_000,
					packedTokens: 100,
					savedTokens: 4_900,
					records: [
						{
							toolName: "grep",
							toolCallId: "tc-1",
							messageIndex: 0,
							reason: "stale-tool-result",
							originalChars: BIG.length,
							originalTokens: 5_000,
							packedTokens: 100,
							key: "stored-original",
							storagePath: "/store/stored-original.txt",
							retrievalAvailable: true,
						},
					],
				},
			},
		);

		expect(result.messages).toBe(packedMessages);
		expect(result.transientMessages).toHaveLength(1);
		const overlay = result.transientMessages[0];
		expect(overlay).toMatchObject({
			role: "custom",
			customType: CONTEXT_VISIBILITY_PROJECTION_CUSTOM_TYPE,
			display: false,
		});
		if (overlay?.role !== "custom") throw new Error("Expected a custom visibility projection");
		expect(Array.isArray(overlay.content)).toBe(true);
		expect(typeof overlay.content === "string" ? overlay.content : JSON.stringify(overlay.content)).toContain(
			"artifact_retrieve context:stored-original",
		);
		expect(JSON.stringify(overlay.content)).not.toContain(ref.id);
		expect(result.report.items[0]).toMatchObject({
			selectedVisibility: "long",
			deliveredVisibility: "long",
			projectionPlacement: "tail_overlay",
		});
	});

	it("fails open to a full tail view while a GC retrieval path is only planned, not readable", () => {
		const store = createInMemoryArtifactStore();
		const { ref } = store.write({
			kind: "tool_output",
			content: BIG,
			toolName: "grep",
			createdAtTurn: 0,
			reproducible: true,
		});
		const sourceMessages = [
			toolResultMessage({ toolCallId: "tc-1", artifactId: ref.id, text: BIG }),
			toolResultMessage({ toolCallId: "tc-2" }),
			toolResultMessage({ toolCallId: "tc-3" }),
			toolResultMessage({ toolCallId: "tc-4" }),
		];
		const plan = planPromptPolicy(runContextAudit(sourceMessages, { turnIndex: 0, artifactStore: store }));
		const packedMessages = sourceMessages.slice();
		packedMessages[0] = toolResultMessage({
			toolCallId: "tc-1",
			artifactId: ref.id,
			text: "[Context GC packed stale tool result]",
			extraDetails: { contextGc: { packed: true } },
		});

		const result = enforcePromptPolicy(
			packedMessages,
			plan,
			settings({ brainRelevance: () => ({ relevant: true, confidence: 0.99 }) }),
			{
				sourceMessages,
				frozenBelow: 1,
				gcReport: {
					enabled: true,
					packedCount: 1,
					originalTokens: 5_000,
					packedTokens: 100,
					savedTokens: 4_900,
					records: [
						{
							toolName: "grep",
							toolCallId: "tc-1",
							messageIndex: 0,
							reason: "stale-tool-result",
							originalChars: BIG.length,
							originalTokens: 5_000,
							packedTokens: 100,
							key: "planned-only",
							storagePath: "/store/planned-only.txt",
							retrievalAvailable: false,
						},
					],
				},
			},
		);

		expect(result.transientMessages).toHaveLength(1);
		const [projection] = result.transientMessages;
		expect(projection?.role).toBe("custom");
		if (projection?.role !== "custom") throw new Error("expected a custom visibility projection");
		expect(JSON.stringify(projection.content)).toContain(BIG);
		expect(JSON.stringify(projection.content)).not.toContain("context:planned-only");
		expect(result.report.items[0]).toMatchObject({
			selectedVisibility: "long",
			deliveredVisibility: "full",
			projectionPlacement: "tail_overlay",
			skipReason: "gc_retrieval_unavailable",
		});
	});

	it("does not rewrite an already-sent raw prefix merely to reduce its query visibility", () => {
		const store = createInMemoryArtifactStore();
		const { ref } = store.write({
			kind: "tool_output",
			content: BIG,
			toolName: "grep",
			createdAtTurn: 0,
			reproducible: true,
		});
		const messages = [
			toolResultMessage({ toolCallId: "tc-1", artifactId: ref.id, text: BIG }),
			toolResultMessage({ toolCallId: "tc-2" }),
			toolResultMessage({ toolCallId: "tc-3" }),
			toolResultMessage({ toolCallId: "tc-4" }),
		];
		const plan = planPromptPolicy(runContextAudit(messages, { turnIndex: 0, artifactStore: store }));

		const result = enforcePromptPolicy(
			messages,
			plan,
			settings({ brainRelevance: () => ({ relevant: false, confidence: 0.99 }) }),
			{
				sourceMessages: messages,
				frozenBelow: 1,
				gcReport: {
					enabled: true,
					packedCount: 0,
					originalTokens: 0,
					packedTokens: 0,
					savedTokens: 0,
					records: [],
				},
			},
		);

		expect(result.messages).toBe(messages);
		expect(result.transientMessages).toEqual([]);
		expect(result.report.items[0]).toMatchObject({
			selectedVisibility: "hidden",
			deliveredVisibility: "full",
			projectionPlacement: "frozen_original",
			enforced: false,
		});
	});

	it("invalidates a speculative projection when its relevance fact changes before acceptance", () => {
		const store = createInMemoryArtifactStore();
		const { ref } = store.write({
			kind: "tool_output",
			content: BIG,
			toolName: "grep",
			createdAtTurn: 0,
			reproducible: true,
		});
		const messages = [
			toolResultMessage({ toolCallId: "tc-1", artifactId: ref.id, text: BIG }),
			toolResultMessage({ toolCallId: "tc-2" }),
			toolResultMessage({ toolCallId: "tc-3" }),
			toolResultMessage({ toolCallId: "tc-4" }),
		];
		const plan = planPromptPolicy(runContextAudit(messages, { turnIndex: 0, artifactStore: store }));
		let verdict = { relevant: true, confidence: 0.99 };

		const result = enforcePromptPolicy(messages, plan, settings({ brainRelevance: () => verdict }));

		expect(result.isCurrent()).toBe(true);
		verdict = { relevant: false, confidence: 0.99 };
		expect(result.isCurrent()).toBe(false);
	});

	it("leaves an item below minChars unchanged", () => {
		const store = createInMemoryArtifactStore();
		const { ref } = store.write({
			kind: "tool_output",
			content: "small",
			toolName: "grep",
			createdAtTurn: 0,
			reproducible: true,
		});
		const messages = [
			toolResultMessage({ toolCallId: "tc-1", artifactId: ref.id, text: "small" }),
			toolResultMessage({ toolCallId: "tc-2" }),
			toolResultMessage({ toolCallId: "tc-3" }),
			toolResultMessage({ toolCallId: "tc-4" }),
		];
		const audit = runContextAudit(messages, { turnIndex: 0, artifactStore: store });
		const plan = planPromptPolicy(audit);

		const result = enforcePromptPolicy(messages, plan, settings({ minChars: 1000 }));

		expect(result.messages).toBe(messages);
		expect(result.report.items[0]?.skipReason).toBe("below_min_chars");
	});

	it("leaves an otherwise-eligible artifact-backed stale item unchanged when the retrieval tool is not active", () => {
		const store = createInMemoryArtifactStore();
		const { ref } = store.write({
			kind: "tool_output",
			content: BIG,
			toolName: "grep",
			createdAtTurn: 0,
			reproducible: true,
		});
		const messages = [
			toolResultMessage({ toolCallId: "tc-1", artifactId: ref.id, text: BIG }),
			toolResultMessage({ toolCallId: "tc-2" }),
			toolResultMessage({ toolCallId: "tc-3" }),
			toolResultMessage({ toolCallId: "tc-4" }),
		];
		const audit = runContextAudit(messages, { turnIndex: 0, artifactStore: store });
		const plan = planPromptPolicy(audit);

		const result = enforcePromptPolicy(messages, plan, settings({ retrievalToolAvailable: false }));

		expect(result.messages).toBe(messages);
		expect(result.report.items[0]?.skipReason).toBe("retrieval_tool_unavailable");
	});

	it("skips an item claiming an available retrieval path when the message itself has no artifactId in details", () => {
		// Synthetic: a shadow-plan item can never legitimately claim hasAvailableRetrievalPath
		// without a real artifactId, but enforcePromptPolicy defends against a mismatched
		// caller-supplied plan/messages pair rather than trusting the plan blindly.
		const messages = [
			toolResultMessage({ toolCallId: "tc-1", text: BIG }),
			toolResultMessage({ toolCallId: "tc-2" }),
			toolResultMessage({ toolCallId: "tc-3" }),
		];
		const plan: PromptPolicyShadowReport = {
			turnIndex: 0,
			items: [
				{
					itemId: "tool-output:tc-1",
					kind: "tool_output",
					retentionClass: "ephemeral",
					source: "tool",
					toolCallId: "tc-1",
					messageIndex: 0,
					primaryRefType: "artifact",
					hasAvailableRetrievalPath: true,
					allowedRetentionActions: ["keep_raw", "pack_to_artifact", "drop_from_prompt"],
					hardConstraints: { keepRaw: [], packToArtifact: [], dropFromPrompt: [], summarize: [] },
					appliedAction: "keep_raw",
				},
			],
		};

		const result = enforcePromptPolicy(messages, plan, settings());

		expect(result.messages).toBe(messages);
		expect(result.report.items[0]?.skipReason).toBe("missing_artifact_id");
	});

	it("skips an item whose hardConstraints.dropFromPrompt is rejected", () => {
		const messages = [
			toolResultMessage({ toolCallId: "tc-1", artifactId: "abc123", text: BIG }),
			toolResultMessage({ toolCallId: "tc-2" }),
			toolResultMessage({ toolCallId: "tc-3" }),
		];
		const plan: PromptPolicyShadowReport = {
			turnIndex: 0,
			items: [
				{
					itemId: "tool-output:tc-1",
					kind: "tool_output",
					retentionClass: "ephemeral",
					source: "tool",
					toolCallId: "tc-1",
					messageIndex: 0,
					primaryRefType: "artifact",
					hasAvailableRetrievalPath: true,
					allowedRetentionActions: ["keep_raw"],
					hardConstraints: {
						keepRaw: [],
						packToArtifact: [],
						dropFromPrompt: ["pinned_user_instruction"],
						summarize: [],
					},
					appliedAction: "keep_raw",
				},
			],
		};

		const result = enforcePromptPolicy(messages, plan, settings());

		expect(result.messages).toBe(messages);
		expect(result.report.items[0]?.skipReason).toBe("hard_constraint_rejected");
	});
});
