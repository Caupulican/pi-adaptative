import "../builtin-install.ts";
import { resolve } from "node:path";
import { expect } from "vitest";
import {
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationProfile,
} from "../../../../src/core/orchestration/contracts.ts";
import { OrchestrationProfileStore } from "../../../../src/core/orchestration/profile-store.ts";
import {
	OPTIONAL_TOOL_INTENT_CUSTOM_TYPE,
	readOptionalToolIntent,
} from "../../../../src/core/tool-applicability-gate.ts";
import type { SessionManager } from "../../../../src/kernel/session/session-manager.ts";
import type { ScriptedRequest } from "../scripted-provider.ts";
import { calls, createBarrier } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, projectPath, withDeadline } from "../session-fixture.ts";

/**
 * The real proper-lockfile runs its exclusion and lease logic; only its filesystem is redirected to the
 * active world's virtual fs through the library's own `fs` option, so no lock directory reaches disk.
 * The library's CJS export object is the one production's default import receives, so its functions
 * are rebound in place rather than through an ESM module mock.
 */
import {
	assertBatchOk,
	E0_FIRST_DELTA,
	E0_SECOND_DELTA,
	expectOwnerWords,
	ICM_CREDENTIAL_KEY,
	LIMITS_PATH,
	lastToolResultDetails,
	latestBatchResults,
} from "./shared.ts";

export async function runJourney1IntentAndBranchingPhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	// E2 (uncertainty and standing revoke, on mode only): a standing revoke survives an uncertain tool judgment and a sub-floor
	// request; only an explicit request above the native floor (hard_gate_auto_confidence .93) lifts it. An uncertain task relation yields an unresolved intent,
	// which the call-time gate reads as no owner decision (its documented contract, asserted as written, not as approval).
	if (world.systemOne.enabled) {
		const e2Owner = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
		const e2Base = {
			changes_model_pools: { kind: "noul", probability: 0.02 },
			capabilities_authorized: { kind: "noul", probability: 0.02 },
			local_commits_only: { kind: "noul", probability: 0.02 },
			lifts_delivery_block: { kind: "noul", probability: 0.02 },
			full_handoff: { kind: "noul", probability: 0.02 },
		} as const;
		const e2Latest = () =>
			readOptionalToolIntent(
				e2Owner.sessionManager.getLatestCustomEntryOnBranch(OPTIONAL_TOOL_INTENT_CUSTOM_TYPE)?.data,
			);
		const e2ToolText = (toolCallId: string): string => {
			const entry = e2Owner.sessionManager
				.getBranch()
				.find(
					(candidate) =>
						candidate.type === "message" &&
						candidate.message.role === "toolResult" &&
						candidate.message.toolCallId === toolCallId,
				);
			if (entry?.type !== "message" || entry.message.role !== "toolResult") {
				throw new Error(`no durable tool result for ${toolCallId}`);
			}
			return entry.message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		};
		// One owner turn: the read classifies the words, then the secret store is called in the same message, so its outcome reads the new intent.
		// The durable native result of one E2 call: its owner-reported details, not only its text.
		const e2ToolDetails = (toolCallId: string): unknown => {
			const entry = e2Owner.sessionManager
				.getBranch()
				.find(
					(candidate) =>
						candidate.type === "message" &&
						candidate.message.role === "toolResult" &&
						candidate.message.toolCallId === toolCallId,
				);
			if (entry?.type !== "message" || entry.message.role !== "toolResult") {
				throw new Error(`no durable tool result for ${toolCallId}`);
			}
			return entry.message.details;
		};
		const e2Turn = async (
			index: number,
			words: string,
			judgments: Parameters<typeof world.systemOne.enterPhase>[1],
		): Promise<string> => {
			world.systemOne.enterPhase(`e2-t${index}`, judgments, {
				expect: expectOwnerWords({
					sessionManager: () => e2Owner.sessionManager,
					userRequests: [words],
					optionalToolNames: ["secret_store"],
				}),
			});
			world.provider.enqueue(
				"root",
				calls(`e2t${index}`, [
					{ id: `e2t${index}-read`, name: "read", arguments: { path: LIMITS_PATH } },
					{ id: `e2t${index}-store`, name: "secret_store", arguments: { action: "activate" } },
				]),
				{ name: `e2t${index}-done`, reply: { content: [{ type: "text", text: `Turn ${index} is done.` }] } },
			);
			await withDeadline(trace, `E2 turn ${index}`, e2Owner.session.prompt(words));
			return e2ToolText(`e2t${index}-store`);
		};
		const FORBIDDEN = "was forbidden by the owner";
		// T1: an explicit request classifies the secret store as allowed.
		const storeT1 = await e2Turn(1, "Use the secret store to read the key.", {
			...e2Base,
			optional_tool_0: { kind: "choice", choice: "request", confidence: 0.97 },
		});
		expect(
			e2Latest()?.allowedTools.map((tool) => tool.toolName),
			"T1: the request allows the secret store",
		).toEqual(["secret_store"]);
		expect(e2Latest()?.revokedTools, "T1: nothing is forbidden yet").toBeUndefined();
		expect(storeT1, "T1: the allowed store call is not refused").not.toContain(FORBIDDEN);
		// T2: an explicit revoke, relation continue, forbids the secret store at call time.
		const storeT2 = await e2Turn(2, "Stop using the secret store for the rest of this task.", {
			...e2Base,
			optional_tool_task: { kind: "choice", choice: "continue", confidence: 0.97 },
			optional_tool_0: { kind: "choice", choice: "revoke", confidence: 0.97 },
		});
		expect(
			e2Latest()?.revokedTools?.map((tool) => tool.toolName),
			"T2: the revoke names the secret store",
		).toEqual(["secret_store"]);
		expect(storeT2, "T2: the forbidden store call is refused").toContain(FORBIDDEN);
		// T3: an uncertain per-tool judgment keeps the prior revoke.
		const storeT3 = await e2Turn(3, "Keep going without the secret store.", {
			...e2Base,
			optional_tool_task: { kind: "choice", choice: "continue", confidence: 0.97 },
			optional_tool_0: { kind: "choice", choice: "uncertain", confidence: 0.97 },
		});
		expect(
			e2Latest()?.revokedTools?.map((tool) => tool.toolName),
			"T3: an uncertain judgment keeps the revoke",
		).toEqual(["secret_store"]);
		expect(storeT3, "T3: the store stays refused").toContain(FORBIDDEN);
		// T4: a request below the confidence floor is no owner decision, so the revoke stands.
		const storeT4 = await e2Turn(4, "Use the secret store again, please.", {
			...e2Base,
			optional_tool_task: { kind: "choice", choice: "continue", confidence: 0.97 },
			optional_tool_0: { kind: "choice", choice: "request", confidence: 0.5 },
		});
		expect(
			e2Latest()?.revokedTools?.map((tool) => tool.toolName),
			"T4: a sub-floor request keeps the revoke",
		).toEqual(["secret_store"]);
		expect(e2Latest()?.allowedTools, "T4: a sub-floor request allows nothing").toEqual([]);
		expect(storeT4, "T4: the store stays refused").toContain(FORBIDDEN);
		// T5: an explicit request above the native .93 floor (scripted .97) is the only lift of the revoke.
		const storeT5 = await e2Turn(5, "Use the secret store now.", {
			...e2Base,
			optional_tool_task: { kind: "choice", choice: "continue", confidence: 0.97 },
			optional_tool_0: { kind: "choice", choice: "request", confidence: 0.97 },
		});
		expect(
			e2Latest()?.allowedTools.map((tool) => tool.toolName),
			"T5: the explicit request lifts the revoke",
		).toEqual(["secret_store"]);
		expect(e2Latest()?.revokedTools, "T5: no revoke remains after the explicit request").toBeUndefined();
		expect(storeT5, "T5: the lifted store call is not refused").not.toContain(FORBIDDEN);
		// T6: a fresh explicit revoke forbids again.
		const storeT6 = await e2Turn(6, "Stop using the secret store for the rest of this task.", {
			...e2Base,
			optional_tool_task: { kind: "choice", choice: "continue", confidence: 0.97 },
			optional_tool_0: { kind: "choice", choice: "revoke", confidence: 0.97 },
		});
		expect(
			e2Latest()?.revokedTools?.map((tool) => tool.toolName),
			"T6: the new revoke names the secret store",
		).toEqual(["secret_store"]);
		expect(storeT6, "T6: the forbidden store call is refused again").toContain(FORBIDDEN);
		// T7: an uncertain task relation yields an unresolved intent, which the call-time gate reads as no owner decision.
		const uncertainWarningsBefore = world.warnings.filter(
			(message) =>
				message ===
				"Optional integrations stay available; owner intent for them was not classified: the judgment was uncertain.",
		).length;
		const storeT7 = await e2Turn(7, "Something unrelated to the store.", {
			...e2Base,
			optional_tool_task: { kind: "choice", choice: "uncertain", confidence: 0.97 },
			optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
		});
		expect(e2Latest()?.status, "T7: an uncertain relation yields an unresolved intent").toBe("unresolved");
		expect(storeT7, "T7: an unresolved intent is no owner decision at call time, as documented").not.toContain(
			FORBIDDEN,
		);
		expect(
			world.warnings.filter(
				(message) =>
					message ===
					"Optional integrations stay available; owner intent for them was not classified: the judgment was uncertain.",
			).length - uncertainWarningsBefore,
			"T7's uncertain relation emits exactly one native warning",
		).toBe(1);
		// T8: the unresolved turn kept the last classified intent as its resume intent, so the relation is asked against the revoke;
		// the explicit request above the native .93 floor lifts it.
		const storeT8 = await e2Turn(8, "Use the secret store once more.", {
			...e2Base,
			optional_tool_task: { kind: "choice", choice: "continue", confidence: 0.97 },
			optional_tool_0: { kind: "choice", choice: "request", confidence: 0.97 },
		});
		expect(e2Latest()?.revokedTools, "T8: the explicit request lifts the resumed revoke").toBeUndefined();
		expect(
			e2Latest()?.allowedTools.map((tool) => tool.toolName),
			"T8: the explicit request allows the store again",
		).toEqual(["secret_store"]);
		expect(storeT8, "T8: the allowed store call is not refused").not.toContain(FORBIDDEN);
		// Each lifted or unresolved call reached the native owner and received its safe unavailability, not a refusal or an unknown tool.
		for (const [label, toolCallId] of [
			["T1", "e2t1-store"],
			["T5", "e2t5-store"],
			["T7", "e2t7-store"],
			["T8", "e2t8-store"],
		] as const) {
			expect(
				e2ToolDetails(toolCallId),
				`${label}: the native activate outcome is the owner's safe unavailability`,
			).toMatchObject({
				action: "activate",
				status: "unavailable",
				code: "owner_setup_required",
			});
		}
		expect(
			await world.disposeSessionInBody(e2Owner.session),
			"the E2 control owner disposes cleanly",
		).toBeUndefined();
	}
	// E2 (on -> off, persisted ban): an on-mode owner's real classified ban persists in its own file. An off session restored
	// from that original file makes no System One request, adds no optional intent, keeps the banned tool out of its active
	// surface, and still reads. Nothing is seeded and no ban is cleared. Only the on-mode world carries this case.
	if (world.systemOne.enabled) {
		const BAN_WORDS = "Stop using the secret store for the rest of this task.";
		const banOwner = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
		world.systemOne.enterPhase(
			"ban-owner",
			{
				changes_model_pools: { kind: "noul", probability: 0.02 },
				capabilities_authorized: { kind: "noul", probability: 0.02 },
				local_commits_only: { kind: "noul", probability: 0.02 },
				lifts_delivery_block: { kind: "noul", probability: 0.02 },
				full_handoff: { kind: "noul", probability: 0.02 },
				optional_tool_0: { kind: "choice", choice: "revoke", confidence: 0.97 },
			},
			{
				expect: expectOwnerWords({
					sessionManager: () => banOwner.sessionManager,
					userRequests: [BAN_WORDS],
					optionalToolNames: ["secret_store"],
				}),
			},
		);
		// The owner's words are classified where their outcome is read: the tool call is that read, so the turn reads first.
		world.provider.enqueue(
			"root",
			calls("ban-read", [{ id: "ban-read-1", name: "read", arguments: { path: LIMITS_PATH } }]),
			{
				name: "ban-read-reported",
				check: (request) => assertBatchOk(request, "ban-read"),
				reply: { content: [{ type: "text", text: "The secret store stays stopped." }] },
			},
		);
		await withDeadline(trace, "ban owner turn", banOwner.session.prompt(BAN_WORDS));
		const banned = readOptionalToolIntent(
			banOwner.sessionManager.getLatestCustomEntryOnBranch(OPTIONAL_TOOL_INTENT_CUSTOM_TYPE)?.data,
		);
		expect(banned?.status, "the owner's words classify into a ban").toBe("classified");
		expect(
			banned?.revokedTools?.map((tool) => tool.toolName),
			"the ban names the secret store",
		).toEqual(["secret_store"]);
		const banFile = banOwner.sessionManager.getSessionFile();
		if (banFile === undefined) throw new Error("the ban owner has no session file");
		expect(await world.disposeSessionInBody(banOwner.session), "the ban owner disposes cleanly").toBeUndefined();

		const optionalIntentIds = (manager: SessionManager): string[] =>
			manager
				.getEntries()
				.flatMap((entry) =>
					entry.type === "custom" && entry.customType === OPTIONAL_TOOL_INTENT_CUSTOM_TYPE ? [entry.id] : [],
				);
		const offManager = world.openSessionManager(banFile);
		const intentIdsBefore = optionalIntentIds(offManager);
		const requestsBefore = world.systemOne.requests.length;
		world.systemOne.enterPhase("ban-off", {});
		const offRoot = await world.createRootSession("root", {
			sessionManager: offManager,
			systemOneEnabled: false,
		});
		expect(offRoot.session.systemOneController, "the off session binds no System One controller").toBeUndefined();
		// The banned tool's non-metadata action is refused at call time by the standing ban, while its metadata stays intentionally available; a plain read still works.
		world.provider.enqueue(
			"root",
			calls("off-secret", [{ id: "off-secret-1", name: "secret_store", arguments: { action: "activate" } }]),
			{
				name: "off-secret-denied",
				check: (request) => {
					const denied = latestBatchResults(request).find((result) => result.toolName === "secret_store");
					if (!denied?.isError || !denied.text.includes("was forbidden by the owner")) {
						throw new Error(`the banned secret store call was not denied: ${denied?.text ?? "no result"}`);
					}
				},
				reply: {
					content: [{ type: "toolCall", id: "off-read-1", name: "read", arguments: { path: LIMITS_PATH } }],
					stopReason: "toolUse",
				},
			},
			{
				name: "off-read-reported",
				check: (request) => assertBatchOk(request, "off-read"),
				reply: {
					content: [{ type: "text", text: "The limits file reads while the secret store stays stopped." }],
				},
			},
		);
		await withDeadline(
			trace,
			"off turn",
			offRoot.session.prompt("Read the limits file while the secret store stays stopped."),
		);
		expect(world.systemOne.requests.length, "the off session makes no System One request").toBe(requestsBefore);
		expect(optionalIntentIds(offRoot.sessionManager), "the off session adds no optional intent").toEqual(
			intentIdsBefore,
		);
		expect(
			readOptionalToolIntent(
				offRoot.sessionManager.getLatestCustomEntryOnBranch(OPTIONAL_TOOL_INTENT_CUSTOM_TYPE)?.data,
			)?.revokedTools?.map((tool) => tool.toolName),
			"the ban is still the latest intent in the off session",
		).toEqual(["secret_store"]);
		expect(
			offRoot.session.messages.some(
				(message) => message.role === "toolResult" && message.toolName === "read" && !message.isError,
			),
			"the plain read works in the off session",
		).toBe(true);
		expect(await world.disposeSessionInBody(offRoot.session), "the off session disposes cleanly").toBeUndefined();
	}
	// E0 (native incremental frames, positive): one root tool call streams in partial frames. The session's own message updates
	// carry the progressive arguments before the call starts; the complete call then runs exactly once and completes natively.
	const e0Root = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
	const e0Log: Array<{ kind: "partial"; args: unknown } | { kind: "start" }> = [];
	let e0Starts = 0;
	const e0OwnedCall = {
		type: "toolCall" as const,
		id: "e0-read-1",
		name: "read",
		arguments: { path: LIMITS_PATH },
	};
	const e0EndSeen = createBarrier();
	const e0EndGate = createBarrier();
	let e0CapturedEnd: { call: unknown; partialArguments: unknown } | undefined;
	const e0Unsubscribe = e0Root.session.subscribe((event) => {
		if (
			event.type === "message_update" &&
			event.message.role === "assistant" &&
			event.assistantMessageEvent.type === "toolcall_delta"
		) {
			const block = event.message.content[event.assistantMessageEvent.contentIndex];
			if (block?.type === "toolCall" && block.id === "e0-read-1") {
				e0Log.push({ kind: "partial", args: JSON.parse(JSON.stringify(block.arguments)) });
			}
		}
		if (
			event.type === "message_update" &&
			event.message.role === "assistant" &&
			event.assistantMessageEvent.type === "toolcall_start"
		) {
			const block = event.message.content[event.assistantMessageEvent.contentIndex];
			if (block?.type === "toolCall" && block.id === "e0-read-1") {
				e0Log.push({ kind: "partial", args: JSON.parse(JSON.stringify(block.arguments)) });
			}
		}
		if (
			event.type === "message_update" &&
			event.message.role === "assistant" &&
			event.assistantMessageEvent.type === "toolcall_end"
		) {
			const endBlock = event.message.content[event.assistantMessageEvent.contentIndex];
			e0CapturedEnd = {
				call: event.assistantMessageEvent.toolCall,
				partialArguments: endBlock?.type === "toolCall" ? endBlock.arguments : undefined,
			};
			e0EndSeen.release();
		}
		if (event.type === "tool_execution_start" && event.toolCallId === "e0-read-1") {
			e0Starts += 1;
			e0Log.push({ kind: "start" });
		}
	});
	const e0Judgments = {
		capabilities_authorized: { kind: "noul", probability: 0.02 },
		changes_model_pools: { kind: "noul", probability: 0.02 },
		local_commits_only: { kind: "noul", probability: 0.02 },
		lifts_delivery_block: { kind: "noul", probability: 0.02 },
		full_handoff: { kind: "noul", probability: 0.02 },
		optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
	} as const;
	world.systemOne.enterPhase("e0-stream", e0Judgments, {
		expect: expectOwnerWords({
			sessionManager: () => e0Root.sessionManager,
			userRequests: ["Read the limits file in pieces."],
			optionalToolNames: ["secret_store"],
		}),
	});
	world.provider.enqueue(
		"root",
		{
			name: "e0-frames",
			frames: [
				{
					partialContent: [{ type: "toolCall", id: "e0-read-1", name: "read", arguments: {} }],
					event: { type: "toolcall_start", contentIndex: 0 },
				},
				{
					partialContent: [
						{
							type: "toolCall",
							id: "e0-read-1",
							name: "read",
							arguments: { path: projectPath("src") },
						},
					],
					event: { type: "toolcall_delta", contentIndex: 0, delta: E0_FIRST_DELTA },
				},
				{
					partialContent: [{ type: "toolCall", id: "e0-read-1", name: "read", arguments: { path: LIMITS_PATH } }],
					event: { type: "toolcall_delta", contentIndex: 0, delta: E0_SECOND_DELTA },
				},
				{
					partialContent: [{ type: "toolCall", id: "e0-read-1", name: "read", arguments: { path: LIMITS_PATH } }],
					event: { type: "toolcall_end", contentIndex: 0, toolCall: e0OwnedCall },
				},
				{
					partialContent: [
						{ type: "toolCall", id: "e0-read-1", name: "read", arguments: { path: LIMITS_PATH } },
						{ type: "text", text: "" },
					],
					event: { type: "text_start", contentIndex: 1 },
					gate: e0EndGate.promise,
				},
			],
			reply: {
				content: [{ type: "toolCall", id: "e0-read-1", name: "read", arguments: { path: LIMITS_PATH } }],
				stopReason: "toolUse",
			},
		},
		{ name: "e0-done", reply: { content: [{ type: "text", text: "The streamed read completed." }] } },
	);
	const e0Turn = e0Root.session.prompt("Read the limits file in pieces.");
	const e0Failures: unknown[] = [];
	try {
		await withDeadline(trace, "E0 native toolcall_end observed", e0EndSeen.promise, 60_000);
		e0OwnedCall.arguments.path = projectPath("src", "mutated-by-scenario.ts");
	} catch (error) {
		e0Failures.push(error);
	} finally {
		e0EndGate.release();
	}
	try {
		await withDeadline(trace, "E0 streamed turn", e0Turn);
	} catch (error) {
		e0Failures.push(error);
	} finally {
		e0Unsubscribe();
	}
	if (e0Failures.length === 1) throw e0Failures[0];
	if (e0Failures.length > 1) {
		throw new AggregateError(e0Failures, "the E0 streamed turn failed before and after its join");
	}
	expect(
		e0CapturedEnd?.call,
		"the native end event keeps the admitted call after the scenario mutates its own object",
	).toEqual({
		type: "toolCall",
		id: "e0-read-1",
		name: "read",
		arguments: { path: LIMITS_PATH },
	});
	expect(e0CapturedEnd?.partialArguments, "the native partial keeps the admitted path").toEqual({
		path: LIMITS_PATH,
	});
	expect(e0CapturedEnd?.call, "the native end event is not the scenario's own object").not.toBe(e0OwnedCall);
	expect(e0Starts, "the streamed call starts exactly once").toBe(1);
	expect(e0Log.at(-1), "the start is the last native event: every partial precedes execution").toEqual({
		kind: "start",
	});
	const e0Intermediate = e0Log
		.flatMap((entry) => (entry.kind === "partial" ? [JSON.stringify(entry.args)] : []))
		.filter((args, index, all) => index === 0 || all[index - 1] !== args);
	expect(e0Intermediate, "the partial arguments are exactly the three native frames, in order").toEqual([
		JSON.stringify({}),
		JSON.stringify({ path: projectPath("src") }),
		JSON.stringify({ path: LIMITS_PATH }),
	]);
	expect(
		e0Root.session.messages.some(
			(message) => message.role === "toolResult" && message.toolCallId === "e0-read-1" && !message.isError,
		),
		"the complete call completes once with a successful result",
	).toBe(true);
	expect(await world.disposeSessionInBody(e0Root.session), "the E0 owner disposes cleanly").toBeUndefined();
	// E0 (native incremental frames, abort mid-stream): the owner is aborted while one frame of the aborted call is held. The admitted
	// transport request's own abort signal is observed before the held frame is released. The aborted call never starts; the aborted
	// assistant terminal binds it; a distinct same-owner continuation runs its own call, and the aborted call's start count stays zero.
	const e0Abort = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
	// The abort owner binds System One exactly as the world does; the presence check is the native binding, not a declared phase.
	expect(
		e0Abort.session.systemOneController !== undefined,
		"the abort owner binds System One with the world mode",
	).toBe(world.systemOne.enabled);
	const e0AbortPartials = createBarrier();
	const e0RequestAborted = createBarrier();
	const e0AbortRelease = createBarrier();
	let e0AbortStarts = 0;
	let e0ContinueStarts = 0;
	const e0AbortUnsubscribe = e0Abort.session.subscribe((event) => {
		if (
			event.type === "message_update" &&
			event.message.role === "assistant" &&
			event.assistantMessageEvent.type === "toolcall_delta"
		) {
			const block = event.message.content[event.assistantMessageEvent.contentIndex];
			if (
				block?.type === "toolCall" &&
				block.id === "e0-abort-1" &&
				JSON.stringify(block.arguments) === JSON.stringify({ path: projectPath("src") })
			) {
				e0AbortPartials.release();
			}
		}
		if (event.type === "tool_execution_start") {
			if (event.toolCallId === "e0-abort-1") e0AbortStarts += 1;
			if (event.toolCallId === "e0-continue-1") e0ContinueStarts += 1;
		}
	});
	world.provider.enqueue("root", {
		name: "e0-abort-frames",
		frames: [
			{
				partialContent: [{ type: "toolCall", id: "e0-abort-1", name: "read", arguments: {} }],
				event: { type: "toolcall_start", contentIndex: 0 },
			},
			{
				partialContent: [
					{
						type: "toolCall",
						id: "e0-abort-1",
						name: "read",
						arguments: { path: projectPath("src") },
					},
				],
				event: { type: "toolcall_delta", contentIndex: 0, delta: E0_FIRST_DELTA },
			},
			{
				partialContent: [{ type: "toolCall", id: "e0-abort-1", name: "read", arguments: { path: LIMITS_PATH } }],
				event: { type: "toolcall_delta", contentIndex: 0, delta: E0_SECOND_DELTA },
				check: (request) => {
					const signal = request.options?.signal;
					if (signal === undefined) throw new Error("the admitted transport request carries no abort signal");
					if (signal.aborted) {
						e0RequestAborted.release();
						return;
					}
					const onAbort = () => {
						signal.removeEventListener("abort", onAbort);
						e0RequestAborted.release();
					};
					signal.addEventListener("abort", onAbort, { once: true });
				},
				gate: e0AbortRelease.promise,
			},
		],
		reply: {
			content: [{ type: "toolCall", id: "e0-abort-1", name: "read", arguments: { path: LIMITS_PATH } }],
			stopReason: "toolUse",
		},
	});
	// The aborted turn reaches no semantic evaluation, so its phase declares no judgments.
	world.systemOne.enterPhase(
		"e0-abort",
		{},
		{
			expect: expectOwnerWords({
				sessionManager: () => e0Abort.sessionManager,
				userRequests: ["Read the limits file, then stop."],
				optionalToolNames: ["secret_store"],
			}),
		},
	);
	const e0AbortPrompt = e0Abort.session.prompt("Read the limits file, then stop.");
	try {
		await withDeadline(trace, "E0 partial arguments observed", e0AbortPartials.promise, 60_000);
		const e0AbortWork = e0Abort.session.abort("the scenario aborts the held E0 frame");
		await withDeadline(trace, "E0 transport request signal aborted", e0RequestAborted.promise, 60_000);
		e0AbortRelease.release();
		await withDeadline(trace, "E0 owner aborted", e0AbortWork, 60_000);
		const e0AbortOutcome = await withDeadline(
			trace,
			"E0 aborted prompt joined",
			e0AbortPrompt.then(
				() => "resolved",
				(error: unknown) => {
					if (error instanceof Error && error.name === "AbortError") return "AbortError";
					throw error;
				},
			),
			60_000,
		);
		expect(["resolved", "AbortError"], "the aborted prompt settles with a native outcome").toContain(e0AbortOutcome);
		expect(e0AbortStarts, "the aborted call never starts").toBe(0);
		expect(
			e0Abort.session.messages.some(
				(message) => message.role === "toolResult" && message.toolCallId === "e0-abort-1",
			),
			"the aborted call produces no result at the abort",
		).toBe(false);
		expect(
			e0Abort.session.messages.some(
				(message) =>
					message.role === "assistant" &&
					message.stopReason === "aborted" &&
					message.content.some((block) => block.type === "toolCall" && block.id === "e0-abort-1"),
			),
			"the aborted assistant terminal binds the aborted call",
		).toBe(true);
		// Same-owner continuation: a distinct call runs once; the aborted call's start count stays zero through it.
		world.provider.enqueue(
			"root",
			calls("e0-continue", [{ id: "e0-continue-1", name: "read", arguments: { path: LIMITS_PATH } }]),
			{
				name: "e0-continue-done",
				reply: { content: [{ type: "text", text: "The limits file reads again." }] },
			},
		);
		// Continuation phase: request-local families come from the transported state; nothing is copied from the positive phase.
		// The pending inputs are read from the owner's branch right now: the aborted input stays pending when this prompt starts.
		const e0PendingInputs = e0Abort.sessionManager
			.getBranch()
			.flatMap((entry) => (entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : []))
			.map((content) =>
				typeof content === "string"
					? content
					: content.map((block) => (block.type === "text" ? block.text : "")).join(""),
			);
		world.systemOne.enterPhase("e0-continue", e0Judgments, {
			expect: expectOwnerWords({
				sessionManager: () => e0Abort.sessionManager,
				userRequests: ["Read the limits file, then stop.", "Read the limits file again."],
				ownerMessages: e0PendingInputs,
				optionalToolNames: ["secret_store"],
			}),
			families: { carries_: { kind: "noul", probability: 0.02 } },
		});
		await withDeadline(trace, "E0 same-owner continuation", e0Abort.session.prompt("Read the limits file again."));
		expect(e0AbortStarts, "the aborted call never starts, through the continuation too").toBe(0);
		expect(e0ContinueStarts, "the continuation's own call runs exactly once").toBe(1);
		expect(
			e0Abort.session.messages.some(
				(message) => message.role === "toolResult" && message.toolCallId === "e0-continue-1" && !message.isError,
			),
			"the continuation's call completes with a successful result",
		).toBe(true);
	} finally {
		e0AbortRelease.release();
		e0AbortUnsubscribe();
	}
	expect(await world.disposeSessionInBody(e0Abort.session), "the E0 abort owner disposes cleanly").toBeUndefined();
	// E4 (branch-memory reload): a user memory is user-scoped, so a memory saved on one branch survives the tree moving to an earlier point.
	// The new branch lists that entry once, and a reload of the same session file lists the same single entry on the same leaf.
	const E4_PREFERENCE = "The owner prefers short functions.";
	const e4Created = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
	const e4Session = e4Created.session;
	const e4Manager = e4Created.sessionManager;
	const e4Source = (): string => {
		const owner = e4Manager
			.getBranch()
			.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					JSON.stringify(entry.message.content).includes("short functions"),
			);
		if (owner === undefined) throw new Error("Owner message with the cited words is not on the session branch");
		return `${e4Manager.getSessionId().slice(0, 8)}/${owner.id}`;
	};
	const e4Count = (text: string): number => text.split(E4_PREFERENCE).length - 1;
	const e4Judgments = {
		changes_model_pools: { kind: "noul" as const, probability: 0.02 },
		local_commits_only: { kind: "noul" as const, probability: 0.02 },
		lifts_delivery_block: { kind: "noul" as const, probability: 0.02 },
		full_handoff: { kind: "noul" as const, probability: 0.02 },
		optional_tool_0: { kind: "choice" as const, choice: "unchanged", confidence: 0.97 },
		capabilities_authorized: { kind: "noul" as const, probability: 0.02 },
	};
	const e4ListCheck = (label: string) => (request: ScriptedRequest) => {
		const listed = latestBatchResults(request).find((result) => result.toolName === "memory");
		if (listed?.isError || e4Count(listed?.text ?? "") !== 1) {
			throw new Error(`${label}: the saved preference is not listed exactly once: ${listed?.text ?? "no result"}`);
		}
	};
	// The save, on the first branch: a memory add cited to the owner's own words.
	world.systemOne.enterPhase("e4-save", e4Judgments);
	world.provider.enqueue(
		"root",
		{
			name: "e4-save-call",
			reply: () => ({
				content: [
					{
						type: "toolCall",
						id: "e4-memory-1",
						name: "memory",
						arguments: {
							action: "add",
							target: "user",
							scope: "global",
							basis: "explicit",
							content: E4_PREFERENCE,
							evidence: [{ source: e4Source(), quote: "I prefer short functions" }],
						},
					},
				],
				stopReason: "toolUse",
			}),
		},
		{
			name: "e4-save-reply",
			check: () => {
				const added = lastToolResultDetails(e4Session, "memory");
				if (typeof added !== "object" || added === null || !("success" in added) || added.success !== true) {
					throw new Error(`the E4 memory add was not successful: ${JSON.stringify(added)}`);
				}
			},
			reply: { content: [{ type: "text", text: "Short functions are recorded." }] },
		},
	);
	await withDeadline(trace, "E4 save turn", e4Session.prompt("Remember that I prefer short functions."));
	// The tree moves back to the owner entry: the save's branch is abandoned, and the new branch starts from the owner's message.
	const e4Owner = e4Manager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "user");
	if (e4Owner === undefined) throw new Error("E4 has no owner entry");
	const e4Nav = await withDeadline(trace, "E4 navigate to the owner entry", e4Session.navigateTree(e4Owner.id));
	// Selecting a user message moves the leaf to its parent and hands its text back for editing.
	expect(e4Nav.editorText, "the owner text is handed back for editing").toContain("short functions");
	if (e4Owner.parentId === null) throw new Error("the E4 owner has no parent entry");
	expect(e4Manager.getLeafId(), "the tree moved to the owner parent").toBe(e4Owner.parentId);
	expect(
		e4Manager
			.getBranch()
			.some(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolCallId === "e4-memory-1",
			),
		"the save sits on an abandoned branch after the move",
	).toBe(false);
	// The new branch lists the user memory once: the memory is not branch-scoped.
	world.systemOne.enterPhase("e4-branch", e4Judgments);
	world.provider.enqueue(
		"root",
		calls("e4-list", [{ id: "e4-list-1", name: "memory", arguments: { action: "list", target: "user" } }]),
		{
			name: "e4-list-reply",
			check: e4ListCheck("the new branch"),
			reply: { content: [{ type: "text", text: "The saved preference is listed once." }] },
		},
	);
	await withDeadline(trace, "E4 branch turn", e4Session.prompt("List the saved preferences from this branch."));
	// A reload of the same session file restores the same leaf and lists the same single entry.
	const e4File = e4Manager.getSessionFile();
	if (e4File === undefined) throw new Error("the E4 session has no file");
	expect(await world.disposeSessionInBody(e4Session), "the E4 owner disposes cleanly").toBeUndefined();
	// Disposal writes the owner's final entries (abort, then close), so the tip a reload must restore is the tip after disposal.
	const e4Leaf = e4Manager.getLeafId();
	expect(
		e4Manager
			.getBranch()
			.some(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolCallId === "e4-list-1",
			),
		"the disposed tip still carries the branch listing",
	).toBe(true);
	const e4Reopened = await world.createRootSession("root", { sessionManager: world.openSessionManager(e4File) });
	expect(e4Reopened.sessionManager.getLeafId(), "the reopened owner restores the same leaf").toBe(e4Leaf);
	world.systemOne.enterPhase("e4-reload", e4Judgments);
	world.provider.enqueue(
		"root",
		calls("e4-reload-list", [
			{ id: "e4-reload-list-1", name: "memory", arguments: { action: "list", target: "user" } },
		]),
		{
			name: "e4-reload-reply",
			check: e4ListCheck("the reopened owner"),
			reply: { content: [{ type: "text", text: "The saved preference survives the reload." }] },
		},
	);
	await withDeadline(
		trace,
		"E4 reloaded turn",
		e4Reopened.session.prompt("List the saved preferences after the reload."),
	);
	expect(
		await world.disposeSessionInBody(e4Reopened.session),
		"the reopened E4 owner disposes cleanly",
	).toBeUndefined();
	trace.mark("root", "e4.branch-memory-reloaded");

	// E4 (branch-summary supersession): a held branch summary is superseded by a newer navigation, which aborts it. Owner input queued while
	// the summary is held waits until the navigation settles. A reload while the summary is active is refused; the same reload succeeds once
	// the session is idle. A reopen of the file is a separate control and restores the leaf the owner left.
	const s4Created = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
	const s4Session = s4Created.session;
	const s4Manager = s4Created.sessionManager;
	const s4SummaryAdmitted = createBarrier();
	const s4SummaryGate = createBarrier();
	const s4Queued = "Queued owner input while the summary is held.";
	world.provider.enqueue(
		"root",
		{ name: "s4-turn-a", reply: { content: [{ type: "text", text: "First step planned." }] } },
		{ name: "s4-turn-b", reply: { content: [{ type: "text", text: "Second step planned." }] } },
		{
			name: "s4-summary-held",
			check: () => s4SummaryAdmitted.release(),
			gate: s4SummaryGate.promise,
			reply: { content: [{ type: "text", text: "Summary of the abandoned branch." }] },
		},
	);
	world.systemOne.enterPhase("s4-a", {});
	await withDeadline(trace, "S4 turn A", s4Session.prompt("Plan the first step."));
	const s4TurnA = s4Manager.getLeafId();
	if (s4TurnA === null) throw new Error("S4 has no leaf after its first turn");
	world.systemOne.enterPhase("s4-b", { ...e4Judgments, carries_0: { kind: "noul", probability: 0.02 } });
	await withDeadline(trace, "S4 turn B", s4Session.prompt("Plan the second step."));
	const s4FirstUser = s4Manager
		.getEntries()
		.find((entry) => entry.type === "message" && entry.message.role === "user");
	if (s4FirstUser === undefined) throw new Error("S4 has no first owner entry");
	// Summarized navigation: the summarizer request is admitted and held at its gate.
	world.systemOne.enterPhase("s4-held", {});
	const s4Summary = s4Session.navigateTree(s4FirstUser.id, { summarize: true });
	await withDeadline(trace, "S4 summary held", s4SummaryAdmitted.promise);
	const s4Refusal = await s4Session.reload().then(
		() => undefined,
		(error: unknown) => error,
	);
	expect(
		s4Refusal instanceof Error ? s4Refusal.message : undefined,
		"a reload while the branch summary is active is refused",
	).toContain("branch summarization is active");
	// The queued prompt's submitter hears exactly one verdict, observed through the production preflight callback.
	const s4Verdicts: Array<{ accepted: boolean; ended: unknown }> = [];
	const s4QueuedPrompt = s4Session.prompt(s4Queued, {
		streamingBehavior: "followUp",
		preflightResult: (accepted, ended) => s4Verdicts.push({ accepted, ended }),
	});
	expect(s4Session.getFollowUpMessages(), "owner input waits while the summary is held").toEqual([s4Queued]);
	// A newer navigation supersedes the held summary: the superseded one is cancelled and its summary never applies.
	const s4Second = s4Session.navigateTree(s4TurnA, { summarize: false });
	const s4SummaryResult = await withDeadline(trace, "S4 summary superseded", s4Summary);
	s4SummaryGate.release();
	expect(s4SummaryResult, "the superseded summary is cancelled, not applied").toMatchObject({
		cancelled: true,
		aborted: true,
	});
	const s4SecondResult = await withDeadline(trace, "S4 superseding navigation", s4Second);
	expect(s4SecondResult.cancelled, "the superseding navigation applies").toBe(false);
	const s4Leaf = s4Manager.getEntries().find((entry) => entry.id === s4Manager.getLeafId());
	expect(
		{ type: s4Leaf?.type, parentId: s4Leaf?.parentId },
		"the superseding navigation leaves a settled entry on the turn A reply",
	).toEqual({ type: "custom", parentId: s4TurnA });
	expect(
		s4Manager.getEntries().some((entry) => entry.type === "branch_summary"),
		"no branch summary entry is applied",
	).toBe(false);
	// The owner input held during the summary is delivered after the navigation settles, on the leaf it settles on.
	expect(
		s4Session.getFollowUpMessages(),
		"the held owner input stays in the pending queue after the navigation settles",
	).toEqual([s4Queued]);
	expect(
		world.warnings.filter((message) => message.includes(s4Queued)),
		"the held input is reported once, as context-changed",
	).toEqual([expect.stringContaining("the session context changed before it was admitted")]);
	await withDeadline(trace, "S4 held prompt settled", s4QueuedPrompt);
	expect(s4Verdicts, "the held queued prompt is not accepted, and says it was held for its changed context").toEqual([
		{ accepted: false, ended: { state: "held", reason: "context_changed" } },
	]);
	expect(
		s4Manager
			.getBranch()
			.some(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					JSON.stringify(entry.message.content).includes(s4Queued),
			),
		"the held input is never admitted to the branch",
	).toBe(false);
	world.faultMatrix.witness("R16", { control: false });
	expect(s4Session.clearQueue().followUp, "restoring the held input returns it from the queue").toEqual([s4Queued]);
	// Idle reload: the same control now succeeds and rebuilds the context of the current branch.
	expect(s4Session.getFollowUpMessages(), "no owner input is left queued").toEqual([]);
	const s4ToolNamesBefore = s4Session.getActiveToolNames();
	const s4ReadBefore = s4Session.getToolDefinition("read");
	await withDeadline(trace, "S4 idle reload", s4Session.reload());
	expect(s4Session.getActiveToolNames(), "the idle reload keeps the active tool names").toEqual(s4ToolNamesBefore);
	expect(s4Session.getToolDefinition("read"), "the idle reload rebinds the read tool definition").not.toBe(
		s4ReadBefore,
	);
	expect(s4Session.getToolDefinition("read")?.name, "the rebound definition is the read tool").toBe("read");
	expect(s4Session.messages.length, "the idle reload rebuilds the current branch context").toBe(
		s4Manager.buildSessionContext().messages.length,
	);
	world.faultMatrix.witness("R16", { control: true });
	// Reopen is a separate control: dispose, then reopen the file, and restore the same tip.
	expect(await world.disposeSessionInBody(s4Session), "the S4 owner disposes cleanly").toBeUndefined();
	const s4Tip = s4Manager.getLeafId();
	const s4File = s4Manager.getSessionFile();
	if (s4File === undefined) throw new Error("the S4 session has no file");
	const s4Reopened = await world.createRootSession("root", { sessionManager: world.openSessionManager(s4File) });
	expect(s4Reopened.sessionManager.getLeafId(), "the reopened S4 owner restores the disposed tip").toBe(s4Tip);
	expect(
		JSON.stringify(s4Reopened.session.messages),
		"the reopened S4 history carries no admitted copy of the held input",
	).not.toContain(s4Queued);
	expect(
		await world.disposeSessionInBody(s4Reopened.session),
		"the reopened S4 owner disposes cleanly",
	).toBeUndefined();
	trace.mark("root", "e4.summary-superseded");

	// E4 (delegated memory read): a read-only worker inherits the bounded memory read, never the mutation tool. Its valid query returns the saved
	// preference source-labelled; an over-bound query is refused; a mutation attempt and a raw path read do not reach the stored content.
	// The owner-authored reader preset: the delegated worker gets memory_read only through this preset's tool list and its memory.query ceiling.
	const M4_READER_PROFILE: OrchestrationProfile = {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		profileId: "m4-reader",
		description: "Read-only reader with the bounded memory read.",
		role: "explorer",
		modelPolicy: {
			mode: "fixed",
			candidates: [{ provider: "harness-script", modelId: "worker-a", thinkingLevel: "off" }],
		},
		capabilityCeiling: ["filesystem.read", "memory.query"],
		readOnly: true,
		toolNames: ["read", "memory_read"],
		resourceProfileNames: [],
		dispatchProfileIds: [],
		budget: {},
		maxConcurrent: 1,
		leaseTtlMs: 60_000,
		requireIndependentVerification: false,
		createdAt: "2026-10-08T00:00:00.000Z",
		updatedAt: "2026-10-08T00:00:00.000Z",
	};
	new OrchestrationProfileStore({
		agentDir: world.agentDir,
		cwd: HARNESS_PROJECT_CWD,
		projectTrusted: false,
	}).save(M4_READER_PROFILE, "global");
	// The external lifecycle provider records every prefetch it is handed. Egress is allowed, so the secret predicate is the gate under
	// test: a closed egress policy would skip the provider for every query and prove nothing about the query text.
	const m4LifecyclePrefetches: string[] = [];
	const m4Created = await world.createRootSession("root", {
		sessionManager: world.createSessionManager(),
		settings: { contextPolicy: { memory: { allowExternalEgress: true } } },
		extensionFactories: [
			(pi) => {
				// Registration waits for session_start, which only bindExtensions emits: the session is bound below.
				pi.on("session_start", () => {
					pi.registerMemoryProvider({
						name: "m4-external-lifecycle",
						egress: "external",
						isAvailable: () => true,
						getCapabilities: () => ({ surfaces: ["context"] }),
						initialize: async () => {},
						shutdown: async () => {},
						prefetch: async (query) => {
							m4LifecyclePrefetches.push(query);
							return "";
						},
					});
				});
			},
		],
	});
	const m4Session = m4Created.session;
	// The factory registers at session_start, which only bindExtensions emits: bind before the reader starts.
	await m4Session.bindExtensions({ uiContext: world.humanInput.ui });
	const m4WorkerDone = createBarrier();
	const m4Wake = createBarrier();
	const M4_RAW_PATH = resolve(world.agentDir, "memory", "user.md");
	const m4Query = "short functions";
	const m4OverBound = "x".repeat(4_097);
	// The worker's memory_read query reaches the lifecycle prefetch; in-process delegate instructions do not (no AgentSession.prompt runs).
	const m4SecretQuery = `Look up the staging maps key ${ICM_CREDENTIAL_KEY}`;
	world.provider.enqueue(
		"root",
		calls("m4-start", [
			{
				id: "m4-start-1",
				name: "delegate",
				arguments: {
					action: "start",
					profileId: "m4-reader",
					instructions: "Read the saved short-functions preference through memory, then submit your report.",
				},
			},
		]),
		{
			name: "m4-start-reply",
			check: (request) => {
				const started = latestBatchResults(request).find((result) => result.toolName === "delegate");
				if (started?.isError || !started?.text.includes("delegate started (running)"))
					throw new Error(`the memory reader did not start: ${started?.text ?? "no result"}`);
			},
			reply: { content: [{ type: "text", text: "The memory reader is started." }] },
		},
		{
			name: "m4-wake",
			maxRequests: 8,
			until: (request) => {
				const everything = JSON.stringify(request.context.messages);
				const done = everything.includes("Background worker terminal handoff") && everything.includes("succeeded");
				if (done) m4Wake.release();
				return done;
			},
			reply: { content: [{ type: "text", text: "Background work is still settling." }] },
		},
	);
	world.provider.enqueue(
		"worker-a",
		{
			name: "worker-a-read",
			check: (request) => {
				const offered = (request.context.tools ?? []).map((tool) => tool.name);
				if (!offered.includes("memory_read"))
					throw new Error(`the worker is not offered memory_read: ${offered.join(", ")}`);
				if (offered.includes("memory")) throw new Error("the worker is offered the root mutation tool");
			},
			reply: {
				content: [
					{ type: "toolCall", id: "m4-read-ok", name: "memory_read", arguments: { query: m4Query } },
					{ type: "toolCall", id: "m4-read-over", name: "memory_read", arguments: { query: m4OverBound } },
					{
						type: "toolCall",
						id: "m4-read-secret",
						name: "memory_read",
						arguments: { query: m4SecretQuery },
					},
					{
						type: "toolCall",
						id: "m4-mutate",
						name: "memory",
						arguments: {
							action: "add",
							target: "user",
							scope: "global",
							basis: "explicit",
							content: "A worker-written fact.",
						},
					},
					{ type: "toolCall", id: "m4-raw", name: "read", arguments: { path: M4_RAW_PATH } },
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "worker-a-report",
			check: (request) => {
				const ok = latestBatchResults(request).find(
					(result) => result.toolName === "memory_read" && !result.isError,
				);
				if (!ok?.text.includes(m4Query))
					throw new Error(`the valid query did not return the saved preference: ${ok?.text ?? "none"}`);
				// Both reads return broker text, not a refusal: the secret read takes the same lane path as the normal read, which reaches the provider below.
				const served = latestBatchResults(request).filter(
					(result) => result.toolName === "memory_read" && !result.isError,
				);
				if (served.length !== 2) throw new Error(`expected 2 served memory reads, found ${served.length}`);
				const over = latestBatchResults(request)
					.filter((result) => result.toolName === "memory_read")
					.find((result) => result.isError);
				if (over === undefined)
					throw new Error(
						`the over-bound query was not refused: ${JSON.stringify(latestBatchResults(request).map((result) => ({ tool: result.toolName, isError: result.isError, text: result.text.slice(0, 160) })))}`,
					);
				const mutate = latestBatchResults(request).find((result) => result.text.includes("A worker-written fact."));
				if (mutate !== undefined) throw new Error("a worker mutation reached the memory store");
				const raw = latestBatchResults(request).find((result) => result.toolName === "read");
				if (raw?.isError !== true) throw new Error(`the raw memory path was not refused: ${raw?.text ?? "none"}`);
				m4WorkerDone.release();
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "m4-report",
						name: "submit_report",
						arguments: { status: "completed", summary: "The preference was read through memory." },
					},
				],
				stopReason: "toolUse",
			},
		},
	);
	world.systemOne.enterPhase("m4-start", e4Judgments);
	await withDeadline(trace, "M4 start turn", m4Session.prompt("Start a reader for the short-functions preference."));
	const m4Runtime = m4Session.backgroundLanes.getTaskRuntimeSnapshot();
	expect(
		Object.values(m4Runtime?.attempts ?? {}).map((attempt) => attempt.status),
		"the reader attempt is running after its start turn",
	).toEqual(["running"]);
	await withDeadline(trace, "M4 worker reported", m4WorkerDone.promise);
	// The terminal handoff wakes the idle root by itself; the wake step matches that turn, and the root is idle before the next prompt.
	await withDeadline(trace, "M4 handoff woke the root", m4Wake.promise, 60_000);
	await withDeadline(trace, "M4 root idle after the wake", m4Session.waitForForegroundIdle());
	world.provider.enqueue(
		"root",
		calls("m4-store", [{ id: "m4-store-1", name: "memory", arguments: { action: "list", target: "user" } }]),
		{
			name: "m4-store-reply",
			check: (request) => {
				e4ListCheck("the store after the denied worker mutation")(request);
				const listed = latestBatchResults(request).find((result) => result.toolName === "memory");
				if (listed?.text.includes("A worker-written fact."))
					throw new Error("the denied worker mutation reached the store");
			},
			reply: { content: [{ type: "text", text: "The store holds only the saved preference." }] },
		},
	);
	world.systemOne.enterPhase("m4-store", e4Judgments);
	await withDeadline(
		trace,
		"M4 store re-read",
		m4Session.prompt("List the saved preferences after the reader finished."),
	);
	expect(
		world.provider.reached.filter((name) => name.startsWith("worker-a")),
		"the memory reader ran its two worker steps exactly once",
	).toEqual(["worker-a:worker-a-read", "worker-a:worker-a-report"]);
	expect(
		m4LifecyclePrefetches.filter((query) => query.includes(ICM_CREDENTIAL_KEY)),
		"the secret-shaped worker read never reaches the external lifecycle provider",
	).toEqual([]);
	expect(
		m4LifecyclePrefetches.filter((query) => query === m4Query),
		"the normal worker read reaches the external lifecycle provider exactly once",
	).toEqual([m4Query]);
	expect(await world.disposeSessionInBody(m4Session), "the M4 owner disposes cleanly").toBeUndefined();
	trace.mark("root", "e4.delegated-memory");

	// E4 default policy: the same reader under the default egress policy (external egress closed) hands no read to the external
	// lifecycle provider, the normal read included. Its own root keeps the handoff wake unambiguous, and its worker runs the same query.
	const m4DefaultPrefetches: string[] = [];
	const m4DefaultRegistrations: string[] = [];
	const m4Default = await world.createRootSession("root", {
		sessionManager: world.createSessionManager(),
		extensionFactories: [
			(pi) => {
				// Registration waits for session_start, which only bindExtensions emits: the session is bound below.
				pi.on("session_start", () => {
					pi.registerMemoryProvider({
						name: "m4-external-lifecycle",
						egress: "external",
						isAvailable: () => true,
						getCapabilities: () => ({ surfaces: ["context"] }),
						initialize: async () => {
							m4DefaultRegistrations.push("m4-external-lifecycle");
						},
						shutdown: async () => {},
						prefetch: async (query) => {
							m4DefaultPrefetches.push(query);
							return "";
						},
					});
				});
			},
		],
	});
	await m4Default.session.bindExtensions({ uiContext: world.humanInput.ui });
	const m4DefaultDone = createBarrier();
	const m4DefaultWake = createBarrier();
	world.provider.enqueue(
		"root",
		calls("m4d-start", [
			{
				id: "m4d-start-1",
				name: "delegate",
				arguments: {
					action: "start",
					profileId: "m4-reader",
					instructions: "Read the saved short-functions preference through memory, then submit your report.",
				},
			},
		]),
		{
			name: "m4d-start-reply",
			check: (request) => {
				const started = latestBatchResults(request).find((result) => result.toolName === "delegate");
				if (started?.isError || !started?.text.includes("delegate started (running)"))
					throw new Error(`the default-policy reader did not start: ${started?.text ?? "no result"}`);
			},
			reply: { content: [{ type: "text", text: "The default-policy reader is started." }] },
		},
		{
			name: "m4d-wake",
			maxRequests: 8,
			until: (request) => {
				const everything = JSON.stringify(request.context.messages);
				const done = everything.includes("Background worker terminal handoff") && everything.includes("succeeded");
				if (done) m4DefaultWake.release();
				return done;
			},
			reply: { content: [{ type: "text", text: "Background work is still settling." }] },
		},
	);
	world.provider.enqueue(
		"worker-a",
		{
			name: "worker-a-default-read",
			check: (request) => {
				const offered = (request.context.tools ?? []).map((tool) => tool.name);
				if (!offered.includes("memory_read"))
					throw new Error(`the default-policy worker is not offered memory_read: ${offered.join(", ")}`);
			},
			reply: {
				content: [{ type: "toolCall", id: "m4d-read", name: "memory_read", arguments: { query: m4Query } }],
				stopReason: "toolUse",
			},
		},
		{
			name: "worker-a-default-report",
			check: (request) => {
				const ok = latestBatchResults(request).find(
					(result) => result.toolName === "memory_read" && !result.isError,
				);
				if (!ok?.text.includes(m4Query))
					throw new Error(`the default-policy read did not return the saved preference: ${ok?.text ?? "none"}`);
				m4DefaultDone.release();
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "m4d-report",
						name: "submit_report",
						arguments: { status: "completed", summary: "The preference was read through memory." },
					},
				],
				stopReason: "toolUse",
			},
		},
	);
	world.systemOne.enterPhase("m4d-start", e4Judgments);
	await withDeadline(
		trace,
		"M4 default-policy start turn",
		m4Default.session.prompt("Start a reader for the short-functions preference."),
	);
	await withDeadline(trace, "M4 default-policy worker reported", m4DefaultDone.promise);
	await withDeadline(trace, "M4 default-policy handoff woke the root", m4DefaultWake.promise, 60_000);
	await withDeadline(trace, "M4 default-policy root idle", m4Default.session.waitForForegroundIdle());
	expect(
		m4DefaultRegistrations,
		"the default-policy session initializes the external lifecycle provider, so the zero-call oracle below is not vacuous",
	).toEqual(["m4-external-lifecycle"]);
	expect(
		m4DefaultPrefetches,
		"the default egress policy never hands the normal read to the external lifecycle provider",
	).toEqual([]);
	expect(
		await world.disposeSessionInBody(m4Default.session),
		"the default-policy owner disposes cleanly",
	).toBeUndefined();
	trace.mark("root", "e4.default-policy");
}
