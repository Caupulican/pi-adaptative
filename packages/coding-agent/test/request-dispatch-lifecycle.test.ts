import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	AssistantMessageEventStream,
	createEmptyUsage,
	dispatchGuardedProviderRequest,
	type Model,
} from "@caupulican/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { captureWorkerReceiptOrigin } from "../src/core/delegation/worker-receipt-origin.ts";
import { ForegroundLifecycleAdapter } from "../src/core/foreground-lifecycle-adapter.ts";
import { ownerSessionStorageRoots } from "../src/core/orchestration/session-bundle-lifecycle.ts";
import { projectParentInputs } from "../src/core/parent-input-projection.ts";
import { Agent } from "../src/kernel/agent.ts";
import { DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "../src/kernel/compaction/compaction.ts";
import { convertToLlm } from "../src/kernel/messages.ts";
import {
	parentInputConsumptionOf,
	parentInputMessage,
	parentWakeContent,
	parentWakeOf,
} from "../src/kernel/session/parent-input-ledger.ts";
import { isSessionLifecycleEntry, SessionManager } from "../src/kernel/session/session-manager.ts";

const model: Model<Api> = {
	id: "dispatch-lifecycle-fixture",
	name: "Dispatch lifecycle fixture",
	api: "openai-completions",
	provider: "fixture",
	baseUrl: "https://unused.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 100_000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

describe.each([false, true])("durable dispatch lifecycle, text protocol=%s", (textProtocol) => {
	it.each(["snapshot", "downstream", "healthy"] as const)(
		"retains one request/assistant/terminal pairing after %s",
		async (stage) => {
			const directory = mkdtempSync(join(tmpdir(), "pi-dispatch-lifecycle-"));
			try {
				const agentDir = join(directory, "agent");
				const manager = SessionManager.create(
					directory,
					ownerSessionStorageRoots(agentDir),
					join(directory, "sessions"),
				);
				let current = true;
				let committed = false;
				let commits = 0;
				let physical = 0;
				let observedRequestId: string | undefined;
				const agent = new Agent({
					initialState: {
						model,
						systemPrompt: "Follow the owner.",
						tools: textProtocol
							? [
									{
										name: "lookup",
										label: "Lookup",
										description: "Read a path.",
										parameters: Type.Object({ path: Type.String() }),
										execute: async () => ({ content: [], details: undefined }),
									},
								]
							: [],
					},
					textToolCallProtocol: textProtocol,
					planContext: async ({ messages }) => ({
						messages,
						isCurrent: () => !committed,
						isDispatchCurrent: () => current,
						commit: () => {
							committed = true;
							commits++;
						},
					}),
					streamFn: async (requestModel, _context, options) => {
						await Promise.resolve();
						if (stage === "downstream") current = false;
						return dispatchGuardedProviderRequest(requestModel, options, () => {
							physical++;
							const response: AssistantMessage = {
								role: "assistant",
								api: model.api,
								provider: model.provider,
								model: model.id,
								content: [{ type: "text", text: "Finished." }],
								usage: createEmptyUsage(),
								stopReason: "stop",
								timestamp: 1,
							};
							const stream = new AssistantMessageEventStream();
							stream.push({ type: "done", reason: "stop", message: response });
							return stream;
						});
					},
				});
				const lifecycle = new ForegroundLifecycleAdapter(agent, manager, {
					commitSessionBuffer: () => new Map(),
					commitSessionBufferPrefix: () => new Map(),
				});
				lifecycle.install();
				const snapshot = agent.onProviderRequestSnapshot!;
				agent.onProviderRequestSnapshot = async (context, signal) => {
					await snapshot(context, signal);
					observedRequestId = context.requestId;
					await Promise.resolve();
					if (stage === "snapshot") current = false;
				};
				agent.subscribe((event) => {
					if (
						event.type === "message_end" &&
						(event.message.role === "user" || event.message.role === "assistant")
					)
						lifecycle.appendMessage(event.message, event.origin);
				});
				await agent.prompt("Read the task.");
				expect(commits).toBe(1);
				expect(physical).toBe(stage === "healthy" ? 1 : 0);
				const file = manager.getSessionFile()!;
				expect(readFileSync(file, "utf8")).toContain(observedRequestId);
				const reopened = SessionManager.openReadOnly(file, ownerSessionStorageRoots(agentDir));
				const entries = reopened.getEntries();
				const requests = entries.filter((entry) => entry.type === "request_snapshot");
				const terminals = entries.filter((entry) => entry.type === "provider_request_terminal");
				const assistants = entries.filter(
					(entry) => entry.type === "message" && entry.message.role === "assistant",
				);
				expect(requests).toHaveLength(1);
				expect(terminals).toHaveLength(1);
				expect(assistants).toHaveLength(1);
				expect(terminals[0]).toMatchObject({
					requestId: observedRequestId,
					outcome: stage === "healthy" ? "completed" : "error",
					assistantMessageEntryId: assistants[0]!.id,
				});
				expect(requests[0]!.requestId).toBe(observedRequestId);
				expect(reopened.inspectSessionLifecycle()).toMatchObject({ balanced: true, refusalReasons: [] });
				expect(agent.state.isStreaming).toBe(false);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);
});

function startRequest(manager: SessionManager, requestId: string) {
	manager.appendRequestSnapshot({
		requestId,
		reason: "initial",
		api: model.api,
		provider: model.provider,
		modelId: model.id,
		effectiveConfigFingerprint: "config",
		systemFingerprint: "system",
		toolsFingerprint: "tools",
		historyFingerprint: "history",
		messageEntryIds: [],
	});
}

it("resolves the latest request's exact call across appends and branch changes", () => {
	const manager = SessionManager.inMemory(ownerSessionStorageRoots(process.cwd()), process.cwd());
	const assistant = (): AssistantMessage => ({
		role: "assistant",
		content: [{ type: "toolCall", id: "reused-call", name: "lookup", arguments: {} }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createEmptyUsage(),
		stopReason: "toolUse",
		timestamp: Date.now(),
	});

	const resolve = (name = "lookup") => manager.activeProviderToolInvocationIdentity("reused-call", name);
	expect(() => resolve()).toThrow("no accepted provider request");
	startRequest(manager, "first");
	const firstAssistant = manager.appendMessage(assistant());
	const firstIdentity = resolve();
	manager.appendCustomEntry("test-unrelated");
	expect(resolve()).toBe(firstIdentity);

	startRequest(manager, "second");
	expect(() => resolve()).toThrow("missing or ambiguous");
	manager.appendMessage(assistant());
	expect(resolve()).not.toBe(firstIdentity);
	expect(() => resolve("write")).toThrow("missing or ambiguous");
	manager.appendMessage(assistant(), "local");
	expect(() => resolve()).toThrow("missing or ambiguous");

	manager.branch(firstAssistant);
	expect(resolve()).toBe(firstIdentity);
});

it("retries an interrupted parent wake after an unrelated assistant answer and settles only its bound answer", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-parent-wake-"));
	try {
		const roots = ownerSessionStorageRoots(join(directory, "agent"));
		let manager = SessionManager.create(directory, roots, join(directory, "sessions"));
		const content = "Validate the pending background result.";
		manager.appendParentInput(
			parentInputMessage(
				{
					deliveryId: "pending-background-result",
					payloadDigest: "a".repeat(64),
					origin: captureWorkerReceiptOrigin(manager),
				},
				{ customType: "plan-update", content, display: true },
			),
		);
		const wake = manager.beginParentInputWake()!;
		expect(wake.content).toContain("pending-background-result");
		expect(wake.content).not.toContain(wake.inputs[0]!.payloadDigest);
		const entry = manager.getEntry(wake.entryId);
		if (entry?.type !== "custom_message") throw new Error("Expected a durable wake.");
		const legacyContent = `[Parent input wake ${wake.wakeId}]\nRespond to this detached batch of background inputs in the preceding canonical history. It does not continue any active goal.\n${JSON.stringify(wake.inputs)}`;
		expect(
			parentWakeOf({
				...entry,
				content: legacyContent,
				details: { version: 1, wakeId: wake.wakeId, inputs: wake.inputs, detached: true },
			})?.content,
		).toBe(legacyContent);
		const finish = (requestId: string, stopReason: "error" | "stop", text: string) => {
			const answer = manager.appendMessage({
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: createEmptyUsage(),
				content: [{ type: "text", text }],
				stopReason,
				timestamp: Date.now(),
			});
			manager.appendProviderRequestTerminal(requestId, stopReason === "stop" ? "completed" : "error", answer);
		};
		const project = () =>
			projectParentInputs(
				async ({ messages }) => ({ messages }),
				manager,
				() => 1,
			)({ messages: manager.buildSessionContext().messages, attempt: 0, sentPrefixCount: 0 });
		const endFailed = manager.activateParentInputWake(wake.wakeId);
		expect(manager.getActiveParentInputWake()?.window?.hasExcludedHistory).toBe(false);
		const savedInput = manager.getEntry(wake.inputs[0]!.entryId)!;
		expect(manager.getParentCompactionInputs().project(savedInput)).toMatchObject({
			type: "custom",
			id: savedInput.id,
		});
		expect(JSON.stringify(manager.getParentCompactionInputs().project(savedInput))).not.toContain(content);
		startRequest(manager, "failed");
		manager.recordParentInputWakeRequest("failed", convertToLlm((await project()).messages));
		finish("failed", "error", "Provider rejected the request.");
		endFailed();
		const summaryEntry = manager.branchWithSummary(manager.getLeafId(), "Separate branch handoff.");
		manager.appendCompaction("Separate compaction handoff.", summaryEntry, 200);
		manager.appendMessage({ role: "user", content: "Separate owner question.", timestamp: Date.now() });
		startRequest(manager, "owner-only");
		finish("owner-only", "stop", "Answer to the owner's separate question.");
		manager = SessionManager.open(manager.getSessionFile()!, roots);
		expect(manager.getParentInputWake()).toEqual(wake);
		const inactive = await project();
		expect(JSON.stringify(convertToLlm(inactive.messages))).not.toContain(content);
		const endRetry = manager.activateParentInputWake(wake.wakeId);
		expect(manager.getActiveParentInputWake()?.window?.hasExcludedHistory).toBe(true);
		const canonical = manager.buildSessionContext().messages;
		expect(canonical.at(-1)?.role).toBe("assistant");
		expect(canonical.map((row) => row.role)).toEqual(expect.arrayContaining(["compactionSummary", "branchSummary"]));
		const plan = await project();
		const wire = convertToLlm(plan.messages);
		expect(wire.at(-1)).toMatchObject({
			role: "user",
			content: [{ type: "text", text: parentWakeContent(wake.wakeId, wake.inputs) }],
		});
		expect(JSON.stringify(wire)).toContain(content);
		expect(JSON.stringify(wire)).not.toMatch(
			/Separate owner question|Separate (?:branch|compaction) handoff|Answer to the owner's separate question|Provider rejected the request/,
		);
		expect(manager.buildSessionContext().messages).toEqual(canonical);
		startRequest(manager, "retry");
		expect(() => manager.recordParentInputWakeRequest("retry", convertToLlm(canonical))).toThrow(
			"ends with an assistant",
		);
		const ownerAnswer = canonical.at(-1)!;
		if (ownerAnswer.role !== "assistant") throw new Error("Expected the separate owner answer.");
		expect(() =>
			manager.recordParentInputWakeRequest("retry", [
				{ ...ownerAnswer, content: [{ type: "text", text: content }] },
				wire.at(-1)!,
			]),
		).toThrow("every exact selected parent input");
		manager.recordParentInputWakeRequest("retry", wire);
		finish("retry", "stop", "Background result validated.");
		manager.settleParentInputWake(wake.wakeId);
		endRetry();
		expect(plan.isDispatchCurrent?.()).toBe(false);
		const preparation = prepareCompaction(
			manager.getBranch().filter((row) => !isSessionLifecycleEntry(row)),
			{ ...DEFAULT_COMPACTION_SETTINGS, strategy: "session-replacement" },
			{ parentInputs: manager.getParentCompactionInputs() },
		);
		expect(JSON.stringify(preparation?.messagesToSummarize)).toContain("Background result validated.");
		expect(manager.getPendingParentInputs()).toHaveLength(0);
		expect(manager.getEntries().filter(parentWakeOf)).toHaveLength(1);
		expect(manager.getEntries().flatMap((entry) => parentInputConsumptionOf(entry) ?? [])).toMatchObject([
			{ mode: "turn", requestId: "retry", authorizationEntryId: wake.entryId, inputs: wake.inputs },
		]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

it.each(["initial", "mid-turn"] as const)("discards a declined %s steer without requeuing it", async (timing) => {
	const starts: string[] = [];
	const declined = {
		role: "custom" as const,
		customType: "watch",
		content: "Already settled",
		display: true,
		timestamp: 1,
	};
	let requests = 0;
	const agent = new Agent({
		initialState: { model },
		streamFn: () => {
			if (++requests === 1 && timing === "mid-turn") agent.steer(declined);
			const stream = new AssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant",
				api: model.api,
				model: model.id,
				provider: model.provider,
				usage: createEmptyUsage(),
				content: [{ type: "text", text: "Accepted turn." }],
				stopReason: "stop",
				timestamp: Date.now(),
			};
			stream.push({ type: "done", reason: "stop", message });
			return stream;
		},
	});
	agent.admitQueuedInput = (message) => message !== declined;
	agent.subscribe((event) => {
		if (event.type === "message_start") starts.push(event.message.role);
	});
	if (timing === "initial") {
		agent.steer(declined);
		await agent.continue();
	} else await agent.prompt("Finish the current turn.");
	expect(starts).toEqual(timing === "initial" ? [] : ["user", "assistant"]);
	expect(requests).toBe(timing === "initial" ? 0 : 1);
	agent.admitQueuedInput = undefined;
	await agent.prompt("Next owner request.");
	expect(starts).not.toContain("custom");
	expect(agent.state.messages).not.toContain(declined);
});
