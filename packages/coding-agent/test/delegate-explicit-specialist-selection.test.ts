/**
 * Choosing a specialist on purpose, through the session's own registered `delegate` tool.
 *
 * Two idle specialists of the same specialization exist only because a caller deliberately asked for
 * an independent copy. Once they do, an unnamed start is genuinely ambiguous -- but naming one of
 * them is exactly the disambiguation the refusal asks for, and it must work even when the call also
 * spells out options equivalent to that specialist's admitted grant.
 *
 * The independent copies here are created through the runtime request owner, which already accepts
 * `parallelWork` (frozen batch7). What these cases add is the PUBLIC surface: a model can only submit
 * what the advertised schema admits, so every public call goes through the tool's own
 * `prepareArguments` and the shared `validateToolArguments` gate BEFORE `execute`. Calling `execute`
 * directly would bypass `additionalProperties: false` and could never prove a model can send the
 * field at all.
 *
 * Current behaviour (batch9-production-baseline-manifest.txt): the advertised `delegate` schema has no
 * independent-parallel intent, so a justified independent copy cannot be submitted at all; the adapter
 * ignores the property when handed one directly; and a named `agentId` stops resolving an ambiguity as
 * soon as the same call also spells out equivalent options, because the specialization decision
 * answers `unavailable` before the named target is considered.
 */
import { ToolArgumentValidationError, validateToolArguments } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import type { LaneRecord } from "../src/core/autonomy/lane-tracker.ts";
import type { WorkerDelegationRequest } from "../src/core/delegation/worker-delegation-request.ts";
import type { ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import type { DelegateDispatchToolDetails, DelegateToolInput } from "../src/core/tools/delegate.ts";
import { createReuseHarness, type ReuseHarness } from "./fixtures/specialist-reuse-harness.ts";

/**
 * The independent-parallel intent proposed on the model-facing tool. The runtime request type already
 * carries `parallelWork`; this is the public spelling the advertised schema does not admit yet.
 */
type ProposedDelegateInput = DelegateToolInput & {
	parallelWork?: { independentOf: readonly string[]; justification: string };
};

/** What a public submission produced: either the schema refused it, or the adapter answered. */
type PublicSubmission =
	| { admitted: false; validationError: string }
	| { admitted: true; details: DelegateDispatchToolDetails };

function delegateTool(context: ReuseHarness): ToolDefinition {
	const definition = context.harness.session.getToolDefinition("delegate");
	if (!definition) throw new Error("this session registered no delegate tool");
	return definition;
}

function toolContext(context: ReuseHarness): ExtensionContext {
	return {
		sessionManager: {
			getSessionId: () => context.harness.sessionManager.getSessionId(),
			getLeafId: () => context.harness.sessionManager.getLeafId(),
		},
	} as unknown as ExtensionContext;
}

function dispatchDetails(details: unknown): DelegateDispatchToolDetails {
	if (!details || typeof details !== "object" || Array.isArray(details) || !("started" in details)) {
		throw new TypeError("delegate returned no dispatch details");
	}
	return details as DelegateDispatchToolDetails;
}

/**
 * Submit a call the way a model does: the tool's own argument preparation, then the shared schema
 * gate, then -- only if the schema admitted it -- the adapter.
 */
async function submitDelegate(
	context: ReuseHarness,
	toolCallId: string,
	input: ProposedDelegateInput,
): Promise<PublicSubmission> {
	const tool = delegateTool(context);
	const prepared = (tool.prepareArguments?.(input) ?? input) as ProposedDelegateInput;
	let validated: ProposedDelegateInput;
	try {
		validated = validateToolArguments(
			tool,
			{ type: "toolCall", id: toolCallId, name: "delegate", arguments: prepared },
			{ repairEnabled: false },
		) as ProposedDelegateInput;
	} catch (error) {
		if (!(error instanceof ToolArgumentValidationError)) throw error;
		return { admitted: false, validationError: error.message };
	}
	const result = await tool.execute(toolCallId, validated, undefined, undefined, toolContext(context));
	await context.settleLanes();
	return { admitted: true, details: dispatchDetails(result.details) };
}

/** The adapter alone, for a payload the advertised schema would not carry. */
async function executeDelegateDirectly(
	context: ReuseHarness,
	toolCallId: string,
	input: ProposedDelegateInput,
): Promise<DelegateDispatchToolDetails> {
	const result = await delegateTool(context).execute(toolCallId, input, undefined, undefined, toolContext(context));
	await context.settleLanes();
	return dispatchDetails(result.details);
}

function agentIdOf(record: LaneRecord | undefined): string | undefined {
	return record?.agentId;
}

function assertCompleted(record: LaneRecord | undefined, label: string): LaneRecord {
	if (!record) throw new Error(`${label} produced no lane record`);
	expect(`${label}:${record.status}`).toBe(`${label}:succeeded`);
	return record;
}

/** Durable and provider-visible evidence a refused call must leave untouched. */
function durableShape(context: ReuseHarness) {
	return {
		agents: Object.keys(context.agents()).sort(),
		attempts: context.attempts().length,
		workerRequests: context.workerRequests().length,
	};
}

function outcomeOf(details: DelegateDispatchToolDetails): string {
	return details.started ? "started" : (details.skipReason ?? "refused");
}

/** Two idle specialists of ONE specialization, the second an explicitly justified independent copy. */
async function twoCompatibleIdleSpecialists(context: ReuseHarness): Promise<[string, string]> {
	context.appendWorkerReply("first reviewer done");
	context.appendWorkerReply("second reviewer done");
	const first = await context.harness.session.runWorkerDelegationOnce({ instructions: "Review the lease fences" });
	const firstAgentId = agentIdOf(assertCompleted(first.record, "first reviewer")) ?? "";
	const independent: WorkerDelegationRequest = {
		instructions: "Review the lease fences from a second angle",
		parallelWork: {
			independentOf: [firstAgentId],
			justification: "Two independent reviewers must not share one context.",
		},
	};
	const second = await context.harness.session.runWorkerDelegationOnce(independent);
	if (!second.record) {
		throw new Error(`second reviewer produced no lane record: ${second.started ? "started" : second.skipReason}`);
	}
	const secondAgentId = agentIdOf(assertCompleted(second.record, "second reviewer")) ?? "";
	expect(secondAgentId).not.toBe(firstAgentId);
	expect(Object.keys(context.agents())).toHaveLength(2);
	return [firstAgentId, secondAgentId];
}

describe("delegate explicit specialist selection", () => {
	it("admits a justified independent copy submitted through the public delegate schema", async () => {
		const context = await createReuseHarness();
		context.appendWorkerReply("first public task done");
		context.appendWorkerReply("independent public task done");
		const first = await submitDelegate(context, "call-public-first", {
			action: "start",
			instructions: "Survey the retry ladder",
		});
		expect(first.admitted ? outcomeOf(first.details) : first.validationError).toBe("started");
		const firstAgentId = first.admitted ? (first.details.agentId ?? "") : "";
		expect(firstAgentId).not.toBe("");

		const independent = await submitDelegate(context, "call-public-independent", {
			action: "start",
			instructions: "Survey the retry ladder from a second angle",
			parallelWork: {
				independentOf: [firstAgentId],
				justification: "An independent second reviewer may not inherit the first one's conclusions.",
			},
		});

		// A model can only send what the advertised schema admits. The refusal that tells a caller to
		// ask for an independent copy has to be answerable in the same tool.
		expect(independent.admitted ? "admitted" : independent.validationError).toBe("admitted");
		if (!independent.admitted) throw new Error("the public schema refused the independent-copy intent");
		expect(outcomeOf(independent.details)).toBe("started");
		expect(independent.details.agentId ?? "").not.toBe(firstAgentId);
		expect(Object.keys(context.agents())).toHaveLength(2);
		// The second copy really ran, on its own clean context.
		const requests = context.workerRequests();
		expect(requests).toHaveLength(2);
		expect(requests[1]?.text).toContain("Survey the retry ladder from a second angle");
		expect(requests[1]?.text).not.toContain("first public task done");
	});

	it("does not treat a malformed independent-copy intent as no intent at all", async () => {
		const context = await createReuseHarness();
		context.appendWorkerReply("first malformed-intent task done");
		context.appendWorkerReply("second malformed-intent task done");
		const first = await submitDelegate(context, "call-malformed-first", {
			action: "start",
			instructions: "Chart the write reservations",
		});
		expect(first.admitted ? outcomeOf(first.details) : first.validationError).toBe("started");
		const before = durableShape(context);

		// The adapter is asked directly, because the advertised schema carries no such field yet: this
		// is about what the host does with an intent it cannot validate, not about the wire format.
		const malformed = await executeDelegateDirectly(context, "call-malformed", {
			action: "start",
			instructions: "Chart the write reservations again",
			parallelWork: { independentOf: [first.admitted ? (first.details.agentId ?? "") : ""], justification: "   " },
		});

		// An intent the host cannot validate is not an absent intent: the caller asked for something
		// specific and got no answer about it. Degrading to reuse hides that, and it spends a real turn.
		expect(outcomeOf(malformed)).not.toBe("started");
		expect(durableShape(context)).toEqual(before);
	});

	it("runs on the named specialist when two compatible idle contexts make an unnamed start ambiguous", async () => {
		const context = await createReuseHarness();
		const [, secondAgentId] = await twoCompatibleIdleSpecialists(context);
		context.appendWorkerReply("named continuation done");
		const before = durableShape(context);

		const ambiguous = await submitDelegate(context, "call-ambiguous", {
			action: "start",
			instructions: "Do more of the same review",
		});
		// The ambiguity refusal must be an explicit, bounded answer that leaves nothing behind.
		expect(ambiguous.admitted ? "admitted" : ambiguous.validationError).toBe("admitted");
		if (!ambiguous.admitted) throw new Error("the ambiguous start was refused by the schema");
		expect(outcomeOf(ambiguous.details)).toMatch(/choice|ambiguous|which/i);
		expect(durableShape(context)).toEqual(before);

		const named = await submitDelegate(context, "call-named", {
			action: "start",
			agentId: secondAgentId,
			instructions: "Do more of the same review",
		});

		// Naming one of the two is the answer to that question: the named specialist takes the work on
		// its own context, and no third identity appears.
		expect(named.admitted ? outcomeOf(named.details) : named.validationError).toBe("started");
		if (!named.admitted) throw new Error("the named start was refused by the schema");
		expect(named.details.agentId).toBe(secondAgentId);
		expect(Object.keys(context.agents()).sort()).toEqual(before.agents);
		expect(context.workerRequests().at(-1)?.text).toContain("second reviewer done");
	});

	it("runs on the named specialist even when the call spells out its equivalent options", async () => {
		const context = await createReuseHarness();
		context.appendWorkerReply("first read-only reviewer done");
		context.appendWorkerReply("second read-only reviewer done");
		context.appendWorkerReply("named equivalent-options continuation done");
		const first = await submitDelegate(context, "call-equivalent-first", {
			action: "start",
			instructions: "Audit the read paths",
			readOnly: true,
			toolNames: ["read", "grep"],
		});
		expect(first.admitted ? outcomeOf(first.details) : first.validationError).toBe("started");
		const firstAgentId = first.admitted ? (first.details.agentId ?? "") : "";
		const independent: WorkerDelegationRequest = {
			instructions: "Audit the read paths from a second angle",
			authority: { readOnly: true, toolNames: ["read", "grep"] },
			parallelWork: {
				independentOf: [firstAgentId],
				justification: "A second independent read-only auditor.",
			},
		};
		const second = await context.harness.session.runWorkerDelegationOnce(independent);
		const secondAgentId = agentIdOf(assertCompleted(second.record, "second auditor")) ?? "";
		expect(secondAgentId).not.toBe(firstAgentId);
		const agentsBefore = Object.keys(context.agents()).sort();

		const named = await submitDelegate(context, "call-equivalent-named", {
			action: "start",
			agentId: secondAgentId,
			instructions: "Continue the read-path audit",
			// The same effective admission this specialist already holds, written out in the other order.
			readOnly: true,
			toolNames: ["grep", "read"],
		});

		// Equal effective options are not a different request; they describe the specialist that was
		// named, so they must not turn an explicit selection into a refusal or a new identity -- and the
		// turn must actually continue THAT specialist's conversation.
		expect(named.admitted ? outcomeOf(named.details) : named.validationError).toBe("started");
		if (!named.admitted) throw new Error("the named start was refused by the schema");
		expect(named.details.agentId).toBe(secondAgentId);
		expect(Object.keys(context.agents()).sort()).toEqual(agentsBefore);
		const latest = context.workerRequests().at(-1);
		expect(latest?.text).toContain("Continue the read-path audit");
		expect(latest?.text).toContain("second read-only reviewer done");
		expect(latest?.text).not.toContain("first read-only reviewer done");
	});

	it("negative control: a named specialist with an incompatible grant is refused, not started elsewhere", async () => {
		const context = await createReuseHarness();
		const [firstAgentId] = await twoCompatibleIdleSpecialists(context);
		const before = durableShape(context);

		const incompatible = await submitDelegate(context, "call-incompatible", {
			action: "start",
			agentId: firstAgentId,
			instructions: "Review under a narrower grant",
			readOnly: true,
		});

		// The options describe different work from the named specialist's admission. That is a refusal
		// about this request, never a licence to start it on some other context.
		expect(incompatible.admitted ? "admitted" : incompatible.validationError).toBe("admitted");
		if (!incompatible.admitted) throw new Error("the incompatible named start was refused by the schema");
		expect(outcomeOf(incompatible.details)).not.toBe("started");
		expect(durableShape(context)).toEqual(before);
	});

	it("negative control: an unknown named specialist is refused and creates nothing", async () => {
		const context = await createReuseHarness();
		const [firstAgentId] = await twoCompatibleIdleSpecialists(context);
		const before = durableShape(context);

		const unknown = await submitDelegate(context, "call-unknown", {
			action: "start",
			agentId: `${firstAgentId}-does-not-exist`,
			instructions: "Review on a specialist that does not exist",
		});

		expect(unknown.admitted ? "admitted" : unknown.validationError).toBe("admitted");
		if (!unknown.admitted) throw new Error("the unknown named start was refused by the schema");
		expect(outcomeOf(unknown.details)).not.toBe("started");
		expect(durableShape(context)).toEqual(before);
	});
});
