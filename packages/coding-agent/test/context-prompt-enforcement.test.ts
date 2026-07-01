import { describe, expect, it } from "vitest";
import { createInMemoryArtifactStore } from "../src/core/context/context-artifacts.ts";
import { runContextAudit } from "../src/core/context/context-audit.ts";
import {
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
