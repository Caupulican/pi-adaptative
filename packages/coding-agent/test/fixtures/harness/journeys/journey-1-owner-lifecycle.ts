import "../builtin-install.ts";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { expect } from "vitest";
import { decisionLedgerFile } from "../../../../src/core/agent-paths.ts";
import type { AgentSession, AgentSessionEvent } from "../../../../src/core/agent-session.ts";
import { getResumableHumanInputSnapshot } from "../../../../src/core/human-input.ts";
import { DecisionLedgerStore } from "../../../../src/core/operator-projection/decision-ledger-store.ts";
import { CURRENT_TURN_REFLECTION_STATE_CUSTOM_TYPE } from "../../../../src/core/reflection-controller.ts";
import { isCredentialSecretKey, mockCredentialFields } from "../../../../src/core/secrets/credential-content-mock.ts";
import {
	OPTIONAL_TOOL_INTENT_CUSTOM_TYPE,
	readOptionalToolIntent,
} from "../../../../src/core/tool-applicability-gate.ts";
import { localFileMutationIntentOperations } from "../../../../src/core/tools/file-mutation-intent.ts";
import { routeShellContract } from "../../../../src/core/tools/shell-contract-router.ts";
import type { SessionManager } from "../../../../src/kernel/session/session-manager.ts";
import { calls, createBarrier, text } from "../scripted-provider.ts";
import {
	branchForClosingReflection,
	HARNESS_PROJECT_CWD,
	type HarnessWorld,
	harnessPath,
	projectPath,
	runClosingReflectionTimeout,
	withDeadline,
} from "../session-fixture.ts";
import { VirtualShell } from "../virtual-shell.ts";

/**
 * The real proper-lockfile runs its exclusion and lease logic; only its filesystem is redirected to the
 * active world's virtual fs through the library's own `fs` option, so no lock directory reaches disk.
 * The library's CJS export object is the one production's default import receives, so its functions
 * are rebound in place rather than through an ESM module mock.
 */
import {
	assertBatchOk,
	backgroundTaskIdOf,
	CAPTURED_ACCESS,
	COMPACTION_SUMMARY,
	commandOf,
	delegateResultTexts,
	dynamicCalls,
	expectOwnerWords,
	FOLLOW_UP_REQUEST,
	failureText,
	handoffFor,
	LIMITS_PATH,
	lastToolResultDetails,
	latestBatchResults,
	legendAliasFor,
	ORIGINAL_LIMITS,
	ownerInputCapture,
	REFLECTION_CHECKPOINT_MARKER,
	readPathAliases,
	requestCarriesMarker,
	TASK_REQUEST,
	toolOutcomes,
} from "./shared.ts";

export async function runJourney1OwnerLifecyclePhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	let mainSession: AgentSession | undefined;
	// The operation table captured at module evaluation must reach the virtual tree, not the host.
	await expect(localFileMutationIntentOperations.access(LIMITS_PATH, constants.R_OK)).resolves.toBeUndefined();
	await expect(localFileMutationIntentOperations.access(projectPath("missing.ts"), constants.R_OK)).rejects.toThrow(
		"virtual filesystem",
	);
	// Exclusive copy, as the production edit and write paths issue it: an existing destination is refused and
	// keeps its bytes; an absent destination is created in the virtual tree.
	const copySource = projectPath("src", "copy-source.ts");
	world.io.seed(copySource, "export const COPIED = true;\n");
	await expect(localFileMutationIntentOperations.copyFileExclusive(copySource, LIMITS_PATH)).rejects.toMatchObject({
		code: "EEXIST",
	});
	expect(world.io.readFileSync(LIMITS_PATH, "utf8")).toBe(ORIGINAL_LIMITS);
	const copyTarget = projectPath("src", "copy-target.ts");
	await expect(localFileMutationIntentOperations.copyFileExclusive(copySource, copyTarget)).resolves.toBeUndefined();
	expect(world.io.readFileSync(copyTarget, "utf8")).toBe("export const COPIED = true;\n");
	// The same captured reference resolves against this world's tree.
	await expect(CAPTURED_ACCESS(LIMITS_PATH, constants.R_OK)).resolves.toBeUndefined();
	// SQL boundary, before any session exists: an allowed RAM query runs, and a disk ATTACH is refused by the
	// authorizer. Only the labels this statement appended are consumed; anything else stays and fails settlement.
	const sqlite = process.getBuiltinModule("node:sqlite");
	if (sqlite === undefined) throw new Error("node:sqlite is unavailable");
	const database = new sqlite.DatabaseSync(":memory:");
	database.exec("CREATE TABLE limits (value INTEGER)");
	database.prepare("INSERT INTO limits (value) VALUES (?)").run(3);
	expect(database.prepare("SELECT value FROM limits").get()).toEqual({ value: 3 });
	const escapesBeforeAttach = world.guard.escapes.length;
	let refusal: unknown;
	try {
		database.exec(`ATTACH DATABASE '${projectPath("evil.db")}' AS evil`);
	} catch (error) {
		refusal = error;
	}
	expect(String(refusal), "a disk ATTACH must be refused by the RAM authorizer").toMatch(/not authorized/i);
	const appendedLabels = world.guard.escapes.slice(escapesBeforeAttach);
	expect(appendedLabels).toEqual(["sqlite.attach"]);
	world.guard.escapes.splice(escapesBeforeAttach, appendedLabels.length);
	// Each probe runs one statement and consumes only the labels that statement appended, so an unexpected denial
	// or label stays visible to the assertion instead of being cleared with the probe.
	const probeOn = (
		target: typeof database,
		statement: string,
	): { readonly error: string; readonly labels: readonly string[] } => {
		const before = world.guard.escapes.length;
		let error = "";
		try {
			target.exec(statement);
		} catch (caught) {
			error = String(caught);
		}
		const labels = world.guard.escapes.slice(before);
		world.guard.escapes.splice(before, labels.length);
		return { error, labels };
	};
	const probeSql = (statement: string): { readonly error: string; readonly labels: readonly string[] } =>
		probeOn(database, statement);
	try {
		// Storage pragmas redirect spill files to disk: upper-case, lower-case and mixed-case spellings are all refused.
		for (const statement of [
			"PRAGMA TEMP_STORE=FILE",
			"PRAGMA temp_store=FILE",
			`PRAGMA Temp_Store_Directory='${HARNESS_PROJECT_CWD}'`,
			`PRAGMA temp_store_directory='${HARNESS_PROJECT_CWD}'`,
		]) {
			const probe = probeSql(statement);
			expect(
				{ statement, error: probe.error, labels: probe.labels },
				"a storage pragma is refused by the RAM authorizer",
			).toEqual({
				statement,
				error: expect.stringMatching(/not authorized/i),
				labels: ["sqlite.storage_pragma"],
			});
		}
		// The default memory spill mode stays allowed through the same authorizer.
		database.exec("PRAGMA TEMP_STORE=MEMORY");
		expect(probeSql("PRAGMA temp_store=memory"), "the memory pragma runs with no recorded denial").toEqual({
			error: "",
			labels: [],
		});
		// VACUUM INTO writes a whole database file; load_extension runs native code. Both are controls the authorizer answers.
		const vacuum = probeSql(`VACUUM INTO '${projectPath("vacuum-target.db")}'`);
		expect(
			{ statement: "VACUUM INTO", error: vacuum.error, labels: vacuum.labels },
			"VACUUM INTO is refused by the RAM authorizer",
		).toEqual({
			statement: "VACUUM INTO",
			error: "Error: authorization denied",
			labels: ["sqlite.attach"],
		});
		const extension = probeSql(`SELECT load_extension('${projectPath("missing.so")}')`);
		expect(
			{ statement: "load_extension", error: extension.error, labels: extension.labels },
			"load_extension is refused by the RAM authorizer",
		).toEqual({
			statement: "load_extension",
			error: expect.stringMatching(/not authorized/i),
			labels: ["sqlite.load_extension"],
		});
	} finally {
		database.close();
	}
	// File-backed read-only consumer: the writer creates the file, then the read-only handle opens on that backing. The
	// read-only consumer may not change persistent metadata (refused by exact label); the writer's value stays unchanged,
	// and the connection-only busy_timeout setting stays supported on the read-only handle.
	const statePath = projectPath("state.db");
	const writer = new sqlite.DatabaseSync(statePath);
	let reader: typeof writer | undefined;
	try {
		reader = new sqlite.DatabaseSync(statePath, { readOnly: true });
		const metadataRefusal = probeOn(reader, "PRAGMA user_version = 42");
		expect(
			{ statement: "PRAGMA user_version = 42", error: metadataRefusal.error, labels: metadataRefusal.labels },
			"a read-only handle refuses a metadata setter by exact label",
		).toEqual({
			statement: "PRAGMA user_version = 42",
			error: expect.stringMatching(/not authorized/i),
			labels: ["sqlite.readonly_pragma"],
		});
		expect(writer.prepare("PRAGMA user_version").get(), "the normal handle keeps its user_version").toEqual({
			user_version: 0,
		});
		const busyBefore = world.guard.escapes.length;
		reader.exec("PRAGMA busy_timeout = 100");
		expect(reader.prepare("PRAGMA busy_timeout").get(), "busy_timeout is supported on the read-only handle").toEqual({
			timeout: 100,
		});
		expect(world.guard.escapes.slice(busyBefore), "the supported setting records no denial").toEqual([]);
	} finally {
		reader?.close();
		writer.close();
	}
	let sessionManager: SessionManager | undefined;
	const ownerSourceId = (): string => {
		if (sessionManager === undefined) throw new Error("Owner source requested before the session exists");
		const owner = sessionManager
			.getBranch()
			.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					JSON.stringify(entry.message.content).includes("prefer tabs"),
			);
		if (owner === undefined) throw new Error("Owner message with the cited words is not on the session branch");
		return `${sessionManager.getSessionId().slice(0, 8)}/${owner.id}`;
	};
	const compactionGate = createBarrier();
	world.provider.enqueue(
		"root",
		text("greeting", "Hello, ready for a task."),
		calls("read-limits", [{ id: "read-1", name: "read", arguments: { path: LIMITS_PATH } }]),
		calls("edit-wrong-old-text", [
			{
				id: "edit-bad",
				name: "edit",
				arguments: { path: LIMITS_PATH, edits: [{ oldText: "MAX_RETRIES = 4", newText: "MAX_RETRIES = 5" }] },
			},
		]),
		calls("edit-corrected", [
			{
				id: "edit-good",
				name: "edit",
				arguments: { path: LIMITS_PATH, edits: [{ oldText: "MAX_RETRIES = 3", newText: "MAX_RETRIES = 5" }] },
			},
		]),
		{
			// The owner's own words are the cited evidence; production checks the citation against its ledger.
			name: "remember-preference",
			reply: () => ({
				content: [
					{
						type: "toolCall",
						id: "memory-1",
						name: "memory",
						arguments: {
							action: "add",
							target: "user",
							scope: "global",
							basis: "explicit",
							content: "The owner prefers tabs over spaces.",
							evidence: [{ source: ownerSourceId(), quote: "I prefer tabs over spaces" }],
						},
					},
				],
				stopReason: "toolUse",
			}),
		},
		{
			name: "task-done",
			check: () => {
				const added = lastToolResultDetails(mainSession ?? session, "memory");
				if (typeof added !== "object" || added === null || !("success" in added) || added.success !== true) {
					throw new Error(`the memory add was not successful: ${JSON.stringify(added)}`);
				}
			},
			reply: {
				content: [{ type: "text", text: "MAX_RETRIES is now 5 and your tab preference is recorded." }],
			},
		},
		{
			name: "compaction-summary",
			gate: compactionGate.promise,
			reply: { content: [{ type: "text", text: COMPACTION_SUMMARY }] },
		},
		{
			name: "queued-input-reply",
			check: (request) => {
				const serialized = JSON.stringify(request.context);
				if (!serialized.includes("tabs over spaces"))
					throw new Error("Memory preference missing from projected context");
			},
			reply: { content: [{ type: "text", text: "Continuing with the limits task and your tab preference." }] },
		},
		// The owner's older and newer reordered inputs are queued and delivered as their own turns, after the tab preference turn.
		text("queued-older-reply", "The older owner input is noted."),
		text("queued-newer-reply", "The newer owner input is noted."),
		// After the queued unit of work ends, the reflection checkpoint runs one internal turn before the next owner input.
		{
			name: "queued-reflection-checkpoint",
			check: (request) => {
				if (!requestCarriesMarker(request, REFLECTION_CHECKPOINT_MARKER)) {
					throw new Error("the turn after the queued inputs is not the reflection checkpoint");
				}
			},
			reply: { content: [{ type: "text", text: "The queued owner inputs are reviewed." }] },
		},
		text("continuation", "Still on track."),
	);

	const created = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
	const session = created.session;
	mainSession = session;
	sessionManager = created.sessionManager;
	const messageEnds: string[] = [];
	const compactionEnds: Array<Extract<AgentSessionEvent, { type: "compaction_end" }>> = [];
	// Ordering uses production events only: compaction started, and the follow-up admitted to the queue.
	const compactionStarted = createBarrier();
	const followUpAdmitted = createBarrier();
	session.subscribe((event) => {
		if (event.type === "message_end") messageEnds.push(event.message.role);
		if (event.type === "compaction_start") compactionStarted.release();
		if (event.type === "compaction_end") compactionEnds.push(event);
		if (event.type === "queue_update" && event.followUp.some((queued) => queued.includes("tab preference"))) {
			followUpAdmitted.release();
		}
	});

	// Each phase names the exact System One questions it expects; the owner's greeting is small talk.
	// The greeting turn asks no judgment: its classification is asked later, during the task turn.
	world.systemOne.enterPhase("greeting", {});
	trace.mark("root", "greeting.submit");
	await withDeadline(trace, "greeting reply", session.prompt("Hi there"));
	trace.mark("root", "greeting.reply");

	// The task changes no model pool, delivery rule or handoff; it names no optional tool.
	// The owner's words are checked on the decoded request: the task and its queued follow-up are the only owner inputs,
	// the screened message is the greeting, and the native optional tool is secret_store.
	const taskOracle = expectOwnerWords({
		sessionManager: () => created.sessionManager,
		userRequests: [TASK_REQUEST, FOLLOW_UP_REQUEST],
		ownerMessages: ["Hi there"],
		optionalToolNames: ["secret_store"],
	});
	world.systemOne.enterPhase(
		"task",
		{
			capabilities_authorized: { kind: "noul", probability: 0.02 },
			changes_model_pools: { kind: "noul", probability: 0.02 },
			local_commits_only: { kind: "noul", probability: 0.02 },
			lifts_delivery_block: { kind: "noul", probability: 0.02 },
			full_handoff: { kind: "noul", probability: 0.02 },
			// owner_messages[0] is still the greeting, and the owner names no optional tool in any message.
			carries_0: { kind: "noul", probability: 0.97 },
			optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
		},
		{ expect: taskOracle },
	);
	trace.mark("root", "task.submit");
	await withDeadline(trace, "task turn", session.prompt(TASK_REQUEST));
	trace.mark("root", "task.reply");
	// The add is durable: its managed file holds the saved entry, bytes on disk, not only a success flag.
	expect(world.io.readFileSync(resolve(world.agentDir, "USER.md"), "utf8")).toContain(
		"The owner prefers tabs over spaces.",
	);
	expect(world.io.readFileSync(LIMITS_PATH, "utf8"), toolOutcomes(session)).toContain("MAX_RETRIES = 5");

	// The summary request holds at its gate. The follow-up is queued while compaction is pending, and only
	// the admission event opens the gate: the queued prompt's own promise resolves after its turn, later.
	const compaction = session.compact("Keep the limits task.");
	await withDeadline(trace, "compaction started", compactionStarted.promise);
	trace.mark("root", "compaction.started");
	// The SDK owner edits queued input while compaction is held: wordless input is admitted and taken back,
	// without replacing the standing intent or pretending that a semantic judgment was uncertain.
	const intentBeforeWordlessInput = created.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === OPTIONAL_TOOL_INTENT_CUSTOM_TYPE);
	await withDeadline(trace, "wordless follow-up admitted", trace.track(session.followUp(" \t ")));
	expect(session.getFollowUpMessages(), "the native queue admits the wordless owner input").toEqual([" \t "]);
	expect(
		created.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === OPTIONAL_TOOL_INTENT_CUSTOM_TYPE),
		"wordless admission preserves the standing semantic intent in either mode",
	).toEqual(intentBeforeWordlessInput);
	expect(
		session.takeQueuedMessages().followUp.map((input) => input.text),
		"the owner takes the input back",
	).toEqual([" \t "]);
	expect(session.getFollowUpMessages(), "the withdrawn input leaves no queued work").toEqual([]);
	const queuedTurn = session.prompt("Also keep the tab preference in mind.", { streamingBehavior: "followUp" });
	await withDeadline(trace, "follow-up admitted to the queue", followUpAdmitted.promise);
	trace.mark("root", "queued-input.admitted");
	// Held owner evaluation, reordered, inside the held compaction: an older input's evaluation is held at its gate, a
	// newer contradictory input is classified and admitted first, and the older evaluation returns last. The commit
	// boundary is the native followUp promise, which resolves after the input's classification and admission.
	const classifiedEntries = (): Array<{ id: string; data: unknown }> =>
		created.sessionManager.getEntries().flatMap((entry) => {
			if (entry.type !== "custom" || entry.customType !== OPTIONAL_TOOL_INTENT_CUSTOM_TYPE) return [];
			return readOptionalToolIntent(entry.data)?.status === "classified" ? [{ id: entry.id, data: entry.data }] : [];
		});
	const OLDER_OWNER_WORDS = "Check the secret store status before the compaction.";
	const NEWER_OWNER_WORDS = "Stop using the secret store for the rest of this task.";
	// The newer input's committed optional-tool intent, and every optional-tool intent entry once the older input settled.
	let committedNewerIntentId: string | undefined;
	let intentEntriesBeforeDelivery: Array<{ id: string; data: unknown }> = [];
	const optionalIntentEntries = (): Array<{ id: string; data: unknown }> =>
		created.sessionManager.getEntries().flatMap((entry) => {
			if (entry.type !== "custom" || entry.customType !== OPTIONAL_TOOL_INTENT_CUSTOM_TYPE) return [];
			return [{ id: entry.id, data: entry.data }];
		});
	if (world.systemOne.enabled) {
		const olderReached = createBarrier();
		const releaseOlder = createBarrier();
		// A followUp() is judged in full before it is admitted, as a queued prompt is: no edge class is granted yet, so the
		// still-pending capabilities are asked too.
		world.systemOne.enterPhase(
			"owner-older",
			{
				capabilities_authorized: { kind: "noul", probability: 0.02 },
				changes_model_pools: { kind: "noul", probability: 0.02 },
				local_commits_only: { kind: "noul", probability: 0.02 },
				lifts_delivery_block: { kind: "noul", probability: 0.02 },
				full_handoff: { kind: "noul", probability: 0.02 },
				optional_tool_0: { kind: "choice", choice: "request", confidence: 0.97 },
			},
			{ gate: releaseOlder.promise, ignoresAbort: true, onAdmit: () => olderReached.release() },
		);
		const olderInput = trace.track(session.followUp(OLDER_OWNER_WORDS));
		await withDeadline(trace, "older owner evaluation reached System One", olderReached.promise);
		trace.mark("root", "owner-older.held");
		world.systemOne.enterPhase("owner-newer", {
			capabilities_authorized: { kind: "noul", probability: 0.02 },
			changes_model_pools: { kind: "noul", probability: 0.02 },
			local_commits_only: { kind: "noul", probability: 0.02 },
			lifts_delivery_block: { kind: "noul", probability: 0.02 },
			full_handoff: { kind: "noul", probability: 0.02 },
			optional_tool_0: { kind: "choice", choice: "revoke", confidence: 0.97 },
		});
		await withDeadline(
			trace,
			"newer owner input classified and admitted",
			trace.track(session.followUp(NEWER_OWNER_WORDS)),
		);
		const committed = classifiedEntries().at(-1);
		expect(
			readOptionalToolIntent(committed?.data)?.revokedTools?.map((tool) => tool.toolName),
			"the newer input's revocation is the committed policy before the older evaluation returns",
		).toEqual(["secret_store"]);
		const committedId = committed?.id;
		committedNewerIntentId = committedId;
		releaseOlder.release();
		await withDeadline(trace, "physical older evaluation joined", world.systemOne.joinInFlight(), 60_000);
		await withDeadline(trace, "older owner input settled", olderInput, 60_000);
		expect(
			classifiedEntries().at(-1)?.id,
			"the late older evaluation does not replace the committed newer policy",
		).toBe(committedId);
		expect(
			session.getFollowUpMessages(),
			"both owner inputs remain admitted after the older evaluation returns",
		).toEqual(expect.arrayContaining([OLDER_OWNER_WORDS, NEWER_OWNER_WORDS]));
		intentEntriesBeforeDelivery = optionalIntentEntries();
		// Every owner input this delivery brings was judged when it was submitted: the newer input's judgment is classified, the
		// older input's was superseded by it, and the tab-preference follow-up's is classified or, when the older input's
		// judgment starts before it answers, superseded. Each is carried into the owner-policy queue and never screened. A
		// classified judgment is applied as judged; a superseded one lost only the optional-tool chain to the newer input, so
		// where the queue settles those words their owner policy is judged alone: one request each, asking every policy
		// question (no edge class is granted and no rule is written, so capabilities are asked and rule questions are not)
		// and no optional tool, in owner order (the tab preference, when superseded, before the older input). The superseded
		// words limit delivery to local commits, so the limit a superseded input states is witnessed as applied.
		const policyOnlyQuestions = [
			"capabilities_authorized",
			"changes_model_pools",
			"full_handoff",
			"lifts_delivery_block",
			"local_commits_only",
		];
		const optionalToolState = ["optional_tools", "previous_optional_tool_intent", "pending_owner_requests"];
		world.systemOne.enterPhase(
			"queued-delivery",
			{
				capabilities_authorized: { kind: "noul", probability: 0.02 },
				changes_model_pools: { kind: "noul", probability: 0.02 },
				local_commits_only: { kind: "noul", probability: 0.97 },
				lifts_delivery_block: { kind: "noul", probability: 0.02 },
				full_handoff: { kind: "noul", probability: 0.02 },
			},
			{
				expect: ({ state, questions }) => {
					expect(
						Object.keys(questions).sort(),
						"a superseded input's delivery asks its owner policy alone",
					).toEqual(policyOnlyQuestions);
					const intake = state as Record<string, unknown>;
					expect(
						[OLDER_OWNER_WORDS, FOLLOW_UP_REQUEST],
						"only a superseded input's words are judged again, never the newer input's",
					).toContain(intake.user_request);
					expect(
						optionalToolState.filter((key) => key in intake),
						"the policy-only judgment carries no optional-tool state",
					).toEqual([]);
				},
			},
		);
	} else {
		await withDeadline(trace, "older owner input queued", trace.track(session.followUp(OLDER_OWNER_WORDS)));
		await withDeadline(trace, "newer owner input queued", trace.track(session.followUp(NEWER_OWNER_WORDS)));
	}
	compactionGate.release();
	const compactionResult = await withDeadline(trace, "compaction result", compaction);
	trace.mark("root", "compaction.returned");
	await withDeadline(trace, "queued follow-up turn", queuedTurn);
	// Every queued owner input is delivered as its own turn: the wait covers the older and newer turns as well.
	await withDeadline(trace, "queued inputs settled", session.waitForForegroundIdle());
	trace.mark("root", "queued-input.delivered");
	// Negative controls on the production payload the transport recorded: the oracle rejects the decoded task request when
	// its previous intent is not the native ledger's, and when its owner words were never submitted. Both must be named.
	// System One off sends no requests, so there is no payload to control.
	if (world.systemOne.enabled) {
		const taskRequest = world.systemOne.decoded.find(
			(request) =>
				request.phase === "task" && (request.state as { user_request?: unknown }).user_request === TASK_REQUEST,
		);
		if (taskRequest === undefined) throw new Error("the task request was never decoded by System One");
		const taskState = taskRequest.state as Record<string, unknown>;
		expect(() =>
			taskOracle({
				...taskRequest,
				state: {
					...taskState,
					previous_optional_tool_intent: {
						version: 1,
						status: "classified",
						taskRequest: "A stale intent the native ledger never held",
						allowedTools: [],
					},
				},
			}),
		).toThrow("is not the session's classified intent");
		expect(() => taskOracle({ ...taskRequest, state: { ...taskState, user_request: "Hi there" } })).toThrow(
			"is not one of the phase's owner inputs",
		);
	}

	// Applied means the production result, its compaction_end event, and the persisted session entry agree.
	const ended = compactionEnds.at(-1);
	expect(ended?.aborted, "compaction_end was not recorded as applied").toBe(false);
	expect(ended?.result?.summary).toBe(COMPACTION_SUMMARY);
	expect(compactionResult.summary).toBe(COMPACTION_SUMMARY);
	const compactionEntry = created.sessionManager.getEntries().find((entry) => entry.type === "compaction");
	expect(compactionEntry?.type === "compaction" ? compactionEntry.summary : undefined).toBe(COMPACTION_SUMMARY);
	expect(compactionEntry?.type === "compaction" ? compactionEntry.firstKeptEntryId : undefined).toBe(
		compactionResult.firstKeptEntryId,
	);
	expect(world.provider.reached).toContain("root:queued-input-reply");

	await withDeadline(trace, "continuation turn", session.prompt("Continue."));
	trace.mark("root", "continuation.reply");
	// The continuation's routing settles the delivered owner words, so every one of them has reached owner policy by now.
	if (world.systemOne.enabled) {
		const deliveryJudgments = world.systemOne.decoded
			.filter((request) => request.phase === "queued-delivery")
			.map((request) => (request.state as { user_request?: unknown }).user_request);
		expect(
			[[OLDER_OWNER_WORDS], [FOLLOW_UP_REQUEST, OLDER_OWNER_WORDS]],
			"the superseded older input's owner policy is judged once at its delivery, in owner order",
		).toContainEqual(deliveryJudgments);
		expect(
			optionalIntentEntries(),
			"the policy-only judgments write no optional-tool intent: the newer input's revocation stays committed",
		).toEqual(intentEntriesBeforeDelivery);
		expect(classifiedEntries().at(-1)?.id, "the committed newer policy is still the latest classified intent").toBe(
			committedNewerIntentId,
		);
		// The newer input's judgment, applied after them, neither blocks nor lifts delivery, so it keeps their limit.
		expect(
			session.localCommitBranch(),
			"the delivery limit the superseded input states is owner policy once it is delivered",
		).not.toBeUndefined();
	}

	expect(messageEnds).toContain("user");
	expect(messageEnds).toContain("assistant");

	world.provider.enqueue(
		"root",
		calls("memory-list", [{ id: "memory-list-1", name: "memory", arguments: { action: "list", target: "user" } }]),
		{
			name: "memory-list-reply",
			check: (request) => {
				const listed = latestBatchResults(request).find((result) => result.toolName === "memory");
				if (!listed?.text.includes("The owner prefers tabs over spaces.")) {
					throw new Error(`the fresh memory read did not return the saved entry: ${listed?.text ?? "no result"}`);
				}
			},
			reply: { content: [{ type: "text", text: "Your preference is saved." }] },
		},
	);
	world.systemOne.enterPhase("memory-read", {
		// The queued "Continue." is screened and continues the task: the reordered revoke is the previous intent it reads.
		carries_0: { kind: "noul", probability: 0.02 },
		optional_tool_task: { kind: "choice", choice: "continue", confidence: 0.97 },
		changes_model_pools: { kind: "noul", probability: 0.02 },
		local_commits_only: { kind: "noul", probability: 0.02 },
		// The newer owner words lift the delivery limit the superseded input set, before the turn's first tool call.
		lifts_delivery_block: { kind: "noul", probability: 0.97 },
		full_handoff: { kind: "noul", probability: 0.02 },
		optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
		capabilities_authorized: { kind: "noul", probability: 0.02 },
	});
	await withDeadline(trace, "memory read-back turn", session.prompt("Read back the preference you saved."));
	trace.mark("root", "memory.read-back");
	expect(session.localCommitBranch(), "newer owner words that lift the delivery limit lift it").toBeUndefined();

	// Long project path after compaction. The first read names the raw path; the minted alias then appears in the
	// request-visible PATH ALIASES legend, and the model reads through that alias. The short limits.ts stays unaliased.
	const longPath = projectPath("src", "features", "retry", "configuration", "limits.ts");
	let longAlias: string | undefined;
	const longRequest = `Read ${longPath} and summarize the retry configuration.`;
	const priorIntent = readOptionalToolIntent(
		created.sessionManager.getLatestCustomEntryOnBranch(OPTIONAL_TOOL_INTENT_CUSTOM_TYPE)?.data,
	);
	const longPathJudgments = {
		optional_tool_task: { kind: "choice", choice: "continue", confidence: 0.97 },
		changes_model_pools: { kind: "noul", probability: 0.02 },
		local_commits_only: { kind: "noul", probability: 0.02 },
		lifts_delivery_block: { kind: "noul", probability: 0.02 },
		full_handoff: { kind: "noul", probability: 0.02 },
		optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
		capabilities_authorized: { kind: "noul", probability: 0.02 },
	} as const;
	// The evaluator is unavailable for this whole turn: the owner's long-path request is classified by no one.
	world.systemOne.enterPhase("long-path", longPathJudgments, { outage: true });
	world.provider.enqueue(
		"root",
		calls("read-long-path", [{ id: "read-long-1", name: "read", arguments: { path: longPath } }]),
		dynamicCalls(
			"read-by-alias",
			(request) => {
				longAlias = legendAliasFor(request, longPath);
				if (longAlias === undefined) {
					throw new Error("the long path was not minted into the request-visible PATH ALIASES legend");
				}
				if (legendAliasFor(request, LIMITS_PATH) !== undefined) {
					throw new Error("the short limits path was aliased: the saving threshold is not in effect");
				}
				return [{ id: "read-alias-1", name: "read", arguments: { path: longAlias } }];
			},
			(request) => assertBatchOk(request, "read-long-path"),
		),
		{
			name: "long-alias-reported",
			check: (request) => {
				assertBatchOk(request, "read-by-alias");
				if (!latestBatchResults(request).some((result) => result.text.includes("RETRY_CONFIGURATION"))) {
					throw new Error("the read through the minted alias did not return the long file");
				}
			},
			reply: { content: [{ type: "text", text: "The retry configuration was read by its alias." }] },
		},
	);
	await withDeadline(trace, "long path turn", session.prompt(longRequest));
	if (longAlias === undefined) throw new Error("no alias was observed for the long path");
	trace.mark("root", "long-path.read");
	// The long-path request met an unavailable evaluator. Assert the CURRENT latest native branch entry, not the
	// append-only history: the intent is unresolved, the request is the pending words, the prior classified intent is
	// resumed, and no classification ever answered the request. Off runs send no requests, so they assert nothing here.
	if (world.systemOne.enabled) {
		expect(
			world.systemOne.intendedOutages.length,
			"the long-path intake met an unavailable evaluator",
		).toBeGreaterThan(0);
		const latestIntent = readOptionalToolIntent(
			created.sessionManager.getLatestCustomEntryOnBranch(OPTIONAL_TOOL_INTENT_CUSTOM_TYPE)?.data,
		);
		expect(
			{
				status: latestIntent?.status,
				taskRequest: latestIntent?.taskRequest,
				pendingRequests: latestIntent?.pendingRequests,
			},
			"the unavailable evaluator leaves the current owner intent unresolved, with the request pending",
		).toEqual({ status: "unresolved", taskRequest: longRequest, pendingRequests: [longRequest] });
		expect(latestIntent?.resumeIntent, "the unresolved intent resumes the prior classified intent").toEqual(
			priorIntent,
		);
		const classifiedAsLong = created.sessionManager.getEntries().some((entry) => {
			if (entry.type !== "custom" || entry.customType !== OPTIONAL_TOOL_INTENT_CUSTOM_TYPE) return false;
			const data = readOptionalToolIntent(entry.data);
			return data?.status === "classified" && data.taskRequest === longRequest;
		});
		expect(classifiedAsLong, "no classification was fabricated for the unanswered request").toBe(false);
	}
	// The alias is persisted in the session's SQL alias store, not only in the transcript: read it back through a read-only
	// connection, then close that connection before the body continues.
	const aliasStore = resolve(
		world.agentDir,
		"work",
		"context",
		"sessions",
		created.sessionManager.getSessionId(),
		"index",
		"runtime.sqlite",
	);
	if (!world.io.existsSync(aliasStore)) throw new Error(`the alias store was not written: ${aliasStore}`);
	const storedAliases = readPathAliases(aliasStore);
	expect(
		storedAliases.map((row) => ({ full_path: resolve(row.full_path), alias_id: row.alias_id })),
		"the alias store holds the minted mapping",
	).toContainEqual({ full_path: resolve(longPath), alias_id: longAlias });

	// Approval. A destructive bash command asks the operator, who denies the first attempt: production refuses it before the
	// shell is reached, so nothing reaches the shell transport. The same command, approved, executes exactly one scripted effect.
	const decisions: Array<"deny" | "allow-once"> = ["deny", "allow-once"];
	const askedOperations: string[] = [];
	const confirmations = world.externalConfirmations;
	session.setEdgeConfirmation(async (request) => {
		askedOperations.push(request.operation);
		confirmations.asked += 1;
		confirmations.inFlight += 1;
		try {
			// The operator's answer settles after a turn of the event loop: the callback is genuinely in flight meanwhile.
			await new Promise((resolve) => setImmediate(resolve));
			return decisions.shift() ?? "deny";
		} finally {
			confirmations.inFlight -= 1;
			confirmations.settled += 1;
		}
	});
	let approvedEffects = 0;
	world.shell.enqueue({
		name: "approved-destructive",
		command: "rm -rf .git",
		cwd: HARNESS_PROJECT_CWD,
		output: "",
		exitCode: 0,
		effect: () => {
			approvedEffects += 1;
		},
	});
	world.provider.enqueue(
		"root",
		calls("bash-denied", [{ id: "bash-denied-1", name: "bash", arguments: { command: "rm -rf .git" } }]),
		{
			name: "denied-reported",
			check: (request) => {
				const denied = latestBatchResults(request).find((result) => result.toolName === "bash");
				if (!denied?.isError || !denied.text.includes("declined")) {
					throw new Error(`the denied command was not refused by the operator: ${denied?.text ?? "no result"}`);
				}
				if (world.shell.requests.length !== 0) {
					throw new Error(`a denied command reached the shell: ${JSON.stringify(world.shell.requests)}`);
				}
			},
			reply: {
				content: [{ type: "toolCall", id: "read-between-1", name: "read", arguments: { path: LIMITS_PATH } }],
				stopReason: "toolUse",
			},
		},
		{
			name: "read-between-reported",
			check: (request) => {
				assertBatchOk(request, "denied-reported");
			},
			reply: {
				content: [{ type: "toolCall", id: "bash-approved-1", name: "bash", arguments: { command: "rm -rf .git" } }],
				stopReason: "toolUse",
			},
		},
		{
			name: "approved-reported",
			check: (request) => {
				const approved = latestBatchResults(request).find((result) => result.toolName === "bash");
				if (approved?.isError) throw new Error(`the approved command failed: ${approved.text}`);
				if (world.shell.requests.length !== 1 || approvedEffects !== 1) {
					throw new Error(
						`the approved command ran ${world.shell.requests.length} time(s) with ${approvedEffects} effect(s)`,
					);
				}
			},
			reply: { content: [{ type: "text", text: "The approved removal ran once." }] },
		},
	);
	world.systemOne.enterPhase("approval", {
		carries_0: { kind: "noul", probability: 0.97 },
		optional_tool_task: { kind: "choice", choice: "continue", confidence: 0.97 },
		changes_model_pools: { kind: "noul", probability: 0.02 },
		local_commits_only: { kind: "noul", probability: 0.02 },
		lifts_delivery_block: { kind: "noul", probability: 0.02 },
		full_handoff: { kind: "noul", probability: 0.02 },
		optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
		capabilities_authorized: { kind: "noul", probability: 0.02 },
	});
	await withDeadline(trace, "approval turn", session.prompt("Remove the .git directory of this project."));
	session.setEdgeConfirmation(undefined);
	expect(
		{ ...confirmations, decisionsLeft: decisions.length },
		"every asked confirmation settled, none in flight, no decision left over",
	).toEqual({ asked: askedOperations.length, inFlight: 0, settled: askedOperations.length, decisionsLeft: 0 });
	trace.mark("root", "approval.settled");
	// The next owner classification carries the unresolved long-path request as pending: the native state presents it again.
	if (world.systemOne.enabled) {
		const approvalIntake = world.systemOne.decoded.find(
			(request) =>
				request.phase === "approval" &&
				(request.state as { user_request?: unknown }).user_request === "Remove the .git directory of this project.",
		);
		expect(
			(approvalIntake?.state as { pending_owner_requests?: unknown } | undefined)?.pending_owner_requests,
			"the approval classification re-presents the unresolved long-path request",
		).toEqual([longRequest]);
		// The latest usable state after the approval turn: the owner intent is classified again, not left unresolved.
		const usableIntent = readOptionalToolIntent(
			created.sessionManager.getLatestCustomEntryOnBranch(OPTIONAL_TOOL_INTENT_CUSTOM_TYPE)?.data,
		);
		expect(usableIntent?.status, "the approval classification restores a usable owner intent").toBe("classified");
	}
	expect(askedOperations, "the operator is asked for each attempt").toHaveLength(2);
	expect(askedOperations.every((operation) => operation.includes("rm -rf .git"))).toBe(true);

	// Late approval. The operator's answer to a destructive command is still pending when the owner is aborted. That answer then
	// returns allow-once after the abort: it must reach no shell and record no native grant. The same command asks again on a fresh turn,
	// and that timely answer runs it exactly once.
	const lateGrantsBefore = session.getEdgeGrants();
	const lateAskedHeld = createBarrier();
	const lateAnswer = createBarrier();
	const lateOperations: string[] = [];
	session.setEdgeConfirmation(async (request) => {
		lateOperations.push(request.operation);
		confirmations.asked += 1;
		confirmations.inFlight += 1;
		try {
			if (lateOperations.length === 1) {
				lateAskedHeld.release();
				await lateAnswer.promise;
			} else {
				await new Promise((resolve) => setImmediate(resolve));
			}
			return "allow-once";
		} finally {
			confirmations.inFlight -= 1;
			confirmations.settled += 1;
		}
	});
	let lateEffects = 0;
	world.shell.enqueue({
		name: "late-approved-destructive",
		command: "rm -rf .git",
		cwd: HARNESS_PROJECT_CWD,
		output: "",
		exitCode: 0,
		effect: () => {
			lateEffects += 1;
		},
	});
	world.provider.enqueue(
		"root",
		calls("late-bash-held", [{ id: "late-bash-held-1", name: "bash", arguments: { command: "rm -rf .git" } }]),
		calls("late-bash-fresh", [{ id: "late-bash-fresh-1", name: "bash", arguments: { command: "rm -rf .git" } }]),
		{
			name: "late-fresh-reported",
			check: (request) => {
				const ran = latestBatchResults(request).find((result) => result.toolName === "bash");
				if (ran?.isError) throw new Error(`the timely approval did not run: ${ran.text}`);
			},
			reply: { content: [{ type: "text", text: "The timely approval ran once." }] },
		},
	);
	const lateHeldPrompt = session
		.prompt("Remove the .git directory again, and wait for the operator.")
		.catch((error: unknown) => error);
	await withDeadline(trace, "late approval asked and held", lateAskedHeld.promise);
	const shellBeforeLate = world.shell.requests.length;
	const lateAbort = session.abort("the operator aborts while the approval is held");
	lateAnswer.release();
	await withDeadline(trace, "late approval owner aborted", lateAbort);
	await withDeadline(trace, "late approval held turn settled", lateHeldPrompt);
	expect(lateEffects, "a late allow-once after the abort runs no effect").toBe(0);
	expect(world.shell.requests.length, "a late allow-once after the abort reaches no shell").toBe(shellBeforeLate);
	expect(session.getEdgeGrants(), "a late allow-once records no native grant").toEqual(lateGrantsBefore);
	expect(
		session.messages.some((message) => message.role === "assistant" && message.stopReason === "aborted"),
		"the held turn persists as aborted",
	).toBe(true);
	await withDeadline(
		trace,
		"late approval fresh turn",
		session.prompt("Remove the .git directory again, now that it is approved."),
	);
	session.setEdgeConfirmation(undefined);
	trace.mark("root", "late-approval.settled");
	expect(lateOperations, "the same operation asks again on the fresh turn").toHaveLength(2);
	expect(lateOperations.every((operation) => operation.includes("rm -rf .git"))).toBe(true);
	expect(lateEffects, "the timely approval runs the command exactly once").toBe(1);
	expect(world.shell.requests.length - shellBeforeLate, "the timely approval reaches the shell once").toBe(1);
	expect(confirmations.inFlight, "no late confirmation is left in flight").toBe(0);
	expect(confirmations.settled, "every late confirmation settled").toBe(confirmations.asked);
	expect(session.getEdgeGrants(), "allow-once records no native grant on either attempt").toEqual(lateGrantsBefore);

	// Cancellation. The turn is held at its provider gate until the operator aborts it: the abort persists the turn
	// as aborted, the current input is answered by the next turn, the held reply never reaches the transcript, and
	// the cancelled root starts no worker.
	const currentInput = ownerInputCapture(session, "Current input after the cancel.");
	const providerReached = createBarrier();
	const neverReleased = createBarrier();
	const turnStarted = createBarrier();
	const unsubscribeTurnStart = session.subscribe((event) => {
		if (event.type === "turn_start") turnStarted.release();
	});
	world.provider.enqueue(
		"root",
		{
			name: "cancelled-turn",
			check: () => providerReached.release(),
			gate: neverReleased.promise,
			reply: { content: [{ type: "text", text: "This reply is never delivered." }] },
		},
		{
			name: "current-input-reply",
			check: (request) => currentInput.check(request),
			reply: { content: [{ type: "text", text: "Current input handled." }] },
		},
	);
	const cancelledPrompt = session
		.prompt("Start a long task that the operator cancels.")
		.catch((error: unknown) => error);
	await withDeadline(trace, "cancelled turn started", turnStarted.promise);
	await withDeadline(trace, "cancelled turn reached its provider gate", providerReached.promise);
	await session.abort("operator cancel");
	await withDeadline(trace, "cancelled prompt settled", cancelledPrompt);
	unsubscribeTurnStart();
	trace.mark("root", "turn.cancelled");
	expect(
		session.messages.some((message) => message.role === "assistant" && message.stopReason === "aborted"),
		"the cancelled turn must persist as an aborted assistant message",
	).toBe(true);

	// User bash, driven directly (no model turn). Prewarm with a configured backend starts nothing local; the default backend
	// runs the command through the scripted shell; a per-call operations override runs through its own backend instead.
	const explicitShell = new VirtualShell();
	world.shell.enqueue({
		name: "direct-default",
		command: "echo direct-default",
		cwd: HARNESS_PROJECT_CWD,
		output: "direct-default\n",
		exitCode: 0,
	});
	// The per-call backend receives the command the platform wrapper hands an explicit backend (no python engine): the contract
	// native floor form on win32, the source unchanged elsewhere. An unsupported route fails the scenario here.
	const explicitRoute = routeShellContract("echo direct-explicit", process.platform, { pythonEngine: false });
	if (explicitRoute.kind === "unsupported") throw new Error(explicitRoute.error);
	explicitShell.enqueue({
		name: "direct-explicit",
		command: explicitRoute.command,
		cwd: HARNESS_PROJECT_CWD,
		output: "direct-explicit\n",
		exitCode: 0,
	});
	const shellRequestsBeforePrewarm = world.shell.requests.length;
	await withDeadline(trace, "prewarm settled", session.prewarmShell());
	expect(world.shell.requests.length, "prewarm with a configured backend runs nothing").toBe(
		shellRequestsBeforePrewarm,
	);
	const directDefault = await withDeadline(trace, "direct default bash", session.executeBash("echo direct-default"));
	expect(directDefault.output).toContain("direct-default");
	expect(directDefault.exitCode).toBe(0);
	const directExplicit = await withDeadline(
		trace,
		"direct explicit bash",
		session.executeBash("echo direct-explicit", undefined, { operations: explicitShell }),
	);
	expect(directExplicit.output).toContain("direct-explicit");
	expect(world.shell.requests.map((request) => request.command)).not.toContain("echo direct-explicit");
	explicitShell.assertDrained();
	await explicitShell.dispose();

	// Transport races, driven directly through the shell port: the model tool is not involved, and only the model-tool route is
	// in scope here. A cancellation raised while a step's check runs must reject before its gate is awaited; a cancellation
	// raised by the final output callback must not report a successful exit.
	const checkAbort = new AbortController();
	const raceGate = createBarrier();
	world.shell.enqueue({
		name: "race-abort-during-check",
		command: "race-abort-during-check",
		cwd: HARNESS_PROJECT_CWD,
		output: "",
		exitCode: 0,
		gate: raceGate.promise,
		check: () => checkAbort.abort(),
	});
	const duringCheck = world.shell
		.exec("race-abort-during-check", HARNESS_PROJECT_CWD, {
			onData: () => undefined,
			signal: checkAbort.signal,
		})
		.then(
			() => "exited",
			(error: unknown) => failureText(error),
		);
	expect(await withDeadline(trace, "cancelled during check settled", duringCheck)).toBe("aborted");
	const finalAbort = new AbortController();
	world.shell.enqueue({
		name: "race-abort-after-output",
		command: "race-abort-after-output",
		cwd: HARNESS_PROJECT_CWD,
		output: "only chunk\n",
		exitCode: 0,
	});
	const afterOutput = world.shell
		.exec("race-abort-after-output", HARNESS_PROJECT_CWD, {
			onData: () => finalAbort.abort(),
			signal: finalAbort.signal,
		})
		.then(
			() => "exited",
			(error: unknown) => failureText(error),
		);
	expect(await withDeadline(trace, "cancelled after output settled", afterOutput)).toBe("aborted");
	expect(world.shell.reached).toEqual(expect.arrayContaining(["race-abort-during-check", "race-abort-after-output"]));

	// Shutdown ownership. The main session's own disposal completes. A required SQL write that fails during a
	// session's path-alias release rejects its disposeAndWait, and the SQL connection is still released. Two
	// prompts leave a pending scanned fingerprint in a session that has already persisted one; only close writes it.
	// Decision ledger constructor fault through the real store: its schema exec fails with the scripted message, the constructor
	// disposes its database, the fault is consumed, and no application handle stays open. A normal construction then works.
	const ledgerPath = decisionLedgerFile(`${world.agentDir}-ledger`);
	// The open handles of the live sessions stay open: each construction is judged by the handles it adds or leaves.
	const openSqliteHandles = (): string[] => {
		try {
			world.guard.assertNoOpenSqliteHandles();
			return [];
		} catch (error) {
			return error instanceof Error
				? error.message.replace("Application SQLite handles leaked: ", "").split(", ")
				: [];
		}
	};
	const handlesBeforeFailure = openSqliteHandles();
	world.guard.failNextSqliteOperation("exec", "CREATE TABLE IF NOT EXISTS ledger_meta");
	let ledgerConstruction: unknown;
	try {
		new DecisionLedgerStore({ databasePath: ledgerPath });
	} catch (error) {
		ledgerConstruction = error;
	}
	expect(
		ledgerConstruction instanceof Error ? ledgerConstruction.message : undefined,
		"the schema exec failure is the scripted one",
	).toBe("Scripted SQLite exec failure: CREATE TABLE IF NOT EXISTS ledger_meta");
	world.guard.assertSqliteFaultsConsumed();
	expect(openSqliteHandles(), "the failed construction leaves no handle").toEqual(handlesBeforeFailure);
	const handlesBeforeNormal = openSqliteHandles();
	const normalLedger = new DecisionLedgerStore({ databasePath: ledgerPath });
	normalLedger.close();
	expect(openSqliteHandles(), "the normal construction closes its handle").toEqual(handlesBeforeNormal);

	// Credential content through the real field mock: the lane key that routes a worktree stays readable, secret-keyed values
	// are masked, and a token-shaped value is masked wherever it sits.
	// The api key control uses an opaque value that no token-shape rule matches, so only key classification can mask it.
	expect(isCredentialSecretKey("apiKey"), "apiKey is a credential key").toBe(true);
	expect(isCredentialSecretKey("laneKey"), "the exact laneKey is the only exempt key").toBe(false);
	const laneKeyFields = mockCredentialFields('{"laneKey":"rootwork","apiKey":"opaque-key-value-42"}');
	expect(laneKeyFields, "the lane key is retained").toContain('"laneKey":"rootwork"');
	expect(laneKeyFields, "the api key value is masked by key classification").not.toContain("opaque-key-value-42");
	expect(mockCredentialFields('{"password":"hunter2-secret"}'), "the password value is masked").not.toContain(
		"hunter2-secret",
	);
	const tokenLaneKey = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
	expect(mockCredentialFields(`{"laneKey":"${tokenLaneKey}"}`), "a token-shaped lane key is masked").not.toContain(
		tokenLaneKey,
	);

	currentInput.arm();
	try {
		await withDeadline(trace, "current input after the cancel", session.prompt("Current input after the cancel."));
	} finally {
		currentInput.disarm();
	}
	trace.mark("root", "current-input.reply");
	const transcript = JSON.stringify(session.messages);
	expect(transcript).toContain("Current input handled.");
	expect(transcript, "a cancelled turn's held reply must not reach the transcript").not.toContain(
		"This reply is never delivered.",
	);
	expect(delegateResultTexts(session), "a cancelled root starts no worker").toEqual([]);
	expect(world.provider.reached.filter((step) => !step.startsWith("root:"))).toEqual([]);

	// The background turns ask no judgment of their own; the cleanup turns ask the owner-message question.
	const backgroundJudgments = {
		optional_tool_task: { kind: "choice", choice: "continue", confidence: 0.97 },
		capabilities_authorized: { kind: "noul", probability: 0.02 },
		changes_model_pools: { kind: "noul", probability: 0.02 },
		local_commits_only: { kind: "noul", probability: 0.02 },
		lifts_delivery_block: { kind: "noul", probability: 0.02 },
		full_handoff: { kind: "noul", probability: 0.02 },
		optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
		leaves_machine: { kind: "noul", probability: 0.02 },
		cannot_be_undone: { kind: "noul", probability: 0.02 },
		touches_outside_task: { kind: "noul", probability: 0.02 },
		acquires_external_code: { kind: "noul", probability: 0.02 },
		request_authorizes: { kind: "noul", probability: 0.02 },
		states_tests_pass: { kind: "choice", choice: "no_current_success", confidence: 0.97 },
		states_committed: { kind: "noul", probability: 0.02 },
		states_pushed: { kind: "noul", probability: 0.02 },
		states_published: { kind: "noul", probability: 0.02 },
		states_files_changed: { kind: "noul", probability: 0.02 },
	} as const;
	// A new session's first prompt asks the task questions as well, so the cleanup turns carry the full set.
	const cleanupJudgments = {
		...backgroundJudgments,
		capabilities_authorized: { kind: "noul", probability: 0.02 },
		changes_model_pools: { kind: "noul", probability: 0.02 },
		local_commits_only: { kind: "noul", probability: 0.02 },
		lifts_delivery_block: { kind: "noul", probability: 0.02 },
		full_handoff: { kind: "noul", probability: 0.02 },
		carries_0: { kind: "noul", probability: 0.97 },
		optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
	} as const;

	// Background bash through the real task handoff. The start call is held at its shell gate; the explicit background request
	// hands off at once with a task id, and the completion is matched to that id in the handoff, not to command text.
	const backgroundGate = createBarrier();
	const backgroundHanded = createBarrier();
	const backgroundReflected = createBarrier();
	let backgroundTaskId: string | undefined;
	world.shell.enqueue({
		name: "background-check",
		command: "echo background-check",
		cwd: HARNESS_PROJECT_CWD,
		output: "background-check\n",
		exitCode: 0,
		gate: backgroundGate.promise,
	});
	world.systemOne.enterPhase("background", backgroundJudgments);
	world.provider.enqueue(
		"root",
		calls("background-start", [
			{
				id: "background-start-1",
				name: "bash",
				arguments: { command: "echo background-check", background: true },
			},
		]),
		{
			name: "background-started",
			check: (request) => {
				expect(session.getActiveToolNames(), "tool_task is active, so the handoff path is admitted").toContain(
					"tool_task",
				);
				const bash = session.getToolDefinition("bash");
				expect(
					bash?.backgroundRequested?.({ command: "echo background-check", background: true } as never),
					"an explicit background bash call is requested in its definition",
				).toBe(true);
				expect(
					bash?.backgroundRequested?.({ command: "echo background-check" } as never),
					"a foreground bash call is not requested in its definition",
				).toBe(false);
				backgroundTaskId = backgroundTaskIdOf(request);
			},
			reply: { content: [{ type: "text", text: "The check runs in the background." }] },
		},
		{
			name: "background-reflection",
			check: (request) => {
				if (!requestCarriesMarker(request, REFLECTION_CHECKPOINT_MARKER)) {
					throw new Error("the root turn is not the reflection checkpoint");
				}
				backgroundReflected.release();
			},
			reply: { content: [{ type: "text", text: "Nothing durable to record." }] },
		},
		{
			name: "background-handoff",
			check: (request) => {
				if (backgroundTaskId === undefined) throw new Error("the start result carried no task id");
				if (!handoffFor(request, backgroundTaskId)) {
					throw new Error(`the completion of ${backgroundTaskId} did not reach the foreground root`);
				}
				backgroundHanded.release();
			},
			reply: { content: [{ type: "text", text: "The background check is reported." }] },
		},
	);
	// Closing-reflection checkpoint: the start turn's own analysis is `none`, so its reflection at the tail can only come from a
	// `due` cue with a worthy trigger carried in before it. The persisted cue is read through the controller's branch lookup.
	expect.soft(session.getMemorySystem(), "the reflection gate is open: the memory system is okf").toBe("okf");
	expect
		.soft(
			sessionManager?.getLatestCustomEntryOnBranch(CURRENT_TURN_REFLECTION_STATE_CUSTOM_TYPE)?.data,
			"the carried reflection cue before the background start turn is due, with a worthy trigger",
		)
		.toMatchObject({
			status: "due",
			triggers: expect.arrayContaining([expect.stringMatching(/^(complex|corrective|durable|session-end)$/)]),
		});
	// Two branch copies of this checkpoint, before the start turn: the closing reflection reopens them after the background flow.
	const closingCopies = branchForClosingReflection(sessionManager);
	await withDeadline(trace, "background start turn", session.prompt("Start the check in the background."));
	trace.mark("root", "background.started");
	await withDeadline(trace, "background reflection turn", backgroundReflected.promise, 60_000);
	backgroundGate.release();
	await withDeadline(trace, "background handoff", backgroundHanded.promise, 60_000);
	await withDeadline(trace, "background handoff settled", session.waitForForegroundIdle(), 60_000);
	expect(
		world.shell.requests.filter((request) => request.command === "echo background-check"),
		"the background command physically ran once",
	).toHaveLength(1);

	// Closing reflection timeout: the carried cue buys a reflection on each reopened copy. The held owner quits while that reflection waits
	// at its input: one disclosure, no provider request after quit, and an unchanged file after release. The normal order discloses nothing.
	const closingDisclosure =
		"A reflection turn did not settle within 5s of quit; its work may not have been persisted.";
	const closing = await runClosingReflectionTimeout(world, closingCopies, REFLECTION_CHECKPOINT_MARKER);
	expect(
		closing,
		"the closing reflection is disclosed once at quit, writes nothing on release, and runs in normal order",
	).toEqual({
		heldCueStatus: "due",
		quitWarnings: [closingDisclosure],
		warningsAfterRelease: [closingDisclosure],
		providerRequestsAfterQuit: 0,
		fileUnchangedByRelease: true,
		controlReflectionReached: true,
		controlDisposal: undefined,
		controlQuitWarnings: [],
	});

	// Old handoff against a newer owner turn: a background task started under owner turn A completes while owner turn B is
	// held at its provider gate. B's current request suffix must not carry A's handoff; the handoff is delivered once, on its
	// own idle turn, with the exact task id.
	const heldCheckGate = createBarrier();
	const heldCheckDone = createBarrier();
	const bHeld = createBarrier();
	const releaseB = createBarrier();
	const heldCheckHanded = createBarrier();
	let heldTaskId: string | undefined;
	world.shell.enqueue({
		name: "held-check",
		command: "echo held-check",
		cwd: HARNESS_PROJECT_CWD,
		output: "held-check\n",
		exitCode: 0,
		gate: heldCheckGate.promise,
		check: () => heldCheckDone.release(),
	});
	world.systemOne.enterPhase("held-background", backgroundJudgments);
	world.provider.enqueue(
		"root",
		calls("held-start", [
			{ id: "held-start-1", name: "bash", arguments: { command: "echo held-check", background: true } },
		]),
		{
			name: "held-started",
			check: (request) => {
				heldTaskId = backgroundTaskIdOf(request);
			},
			reply: { content: [{ type: "text", text: "The held check runs in the background." }] },
		},
		{
			name: "owner-b-held",
			gate: releaseB.promise,
			check: () => bHeld.release(),
			reply: {
				content: [{ type: "toolCall", id: "b-read-1", name: "read", arguments: { path: LIMITS_PATH } }],
				stopReason: "toolUse",
			},
		},
		{
			name: "owner-b-boundary",
			check: (request) => {
				if (heldTaskId === undefined) throw new Error("the held start result carried no task id");
				if (handoffFor(request, heldTaskId)) {
					throw new Error(`the old handoff of ${heldTaskId} entered the newer owner turn's current suffix`);
				}
			},
			reply: { content: [{ type: "text", text: "Owner turn B reads the limits file." }] },
		},
		{
			name: "held-handoff",
			check: (request) => {
				if (heldTaskId === undefined) throw new Error("the held start result carried no task id");
				if (!handoffFor(request, heldTaskId)) {
					throw new Error(`the completion of ${heldTaskId} did not reach the foreground root`);
				}
				heldCheckHanded.release();
			},
			reply: { content: [{ type: "text", text: "The held check is reported after owner turn B." }] },
		},
	);
	await withDeadline(trace, "held start turn", session.prompt("Start the held check in the background."));
	trace.mark("root", "held.started");
	const ownerB = session.prompt("Read the limits file once more.");
	await withDeadline(trace, "owner turn B held at its provider gate", bHeld.promise, 60_000);
	heldCheckGate.release();
	await withDeadline(trace, "held background command completed", heldCheckDone.promise, 60_000);
	releaseB.release();
	await withDeadline(trace, "owner turn B ended", ownerB, 60_000);
	await withDeadline(trace, "old handoff delivered on its own turn", heldCheckHanded.promise, 60_000);
	await withDeadline(trace, "old handoff settled", session.waitForForegroundIdle(), 60_000);
	expect(
		world.shell.requests.filter((request) => request.command === "echo held-check"),
		"the held background command physically ran once",
	).toHaveLength(1);

	// Owner order across delivery order. A held turn's own words limit delivery; while it is held at its provider gate, an
	// OLDER follow-up limits delivery too and a NEWER steer lifts it. The steer is delivered at the steering poll, ahead of
	// the older follow-up delivered after the run, so the older limit is applied last: it decides only what no newer owner
	// words decided, and the newer lift stands. The turn's own limit is witnessed as applied before the pair, so a pair that
	// never reached owner policy leaves the limit standing. The in-order case above (the newer lift applied after the older
	// limit) is the normal-order control.
	const DELIVERY_TURN_WORDS = "Prepare the limits change; keep it as local commits only for now.";
	const DELIVERY_LIMIT_WORDS = "Keep the commits on this branch local for now; no push.";
	const DELIVERY_LIFT_WORDS = "Pushing the commits is fine again; publish when the work is done.";
	const orderTurnReached = createBarrier();
	const releaseOrderTurn = createBarrier();
	world.provider.enqueue(
		"root",
		{
			// The turn's first tool call settles its own words: the limit they state binds delivery.
			name: "delivery-order-held",
			check: () => orderTurnReached.release(),
			gate: releaseOrderTurn.promise,
			reply: {
				content: [
					{ type: "toolCall", id: "delivery-order-read-1", name: "read", arguments: { path: LIMITS_PATH } },
				],
				stopReason: "toolUse",
			},
		},
		{
			// The steer is delivered at the steering poll after that batch: the request carries the newer lift and not yet
			// the older limit, and the turn's own limit is the binding until the delivered words settle.
			name: "delivery-order-steer-reply",
			check: (request) => {
				assertBatchOk(request, "delivery-order-held");
				if (!requestCarriesMarker(request, DELIVERY_LIFT_WORDS))
					throw new Error("the newer steer was not delivered");
				if (requestCarriesMarker(request, DELIVERY_LIMIT_WORDS)) {
					throw new Error("the older follow-up was delivered before the newer steer");
				}
				if (world.systemOne.enabled && session.localCommitBranch() === undefined) {
					throw new Error("the turn's own delivery limit was not applied before the reordered pair");
				}
			},
			reply: { content: [{ type: "text", text: "Pushing is allowed again." }] },
		},
		{
			// The older follow-up is delivered after the run; its tool call settles the delivered pair, the steer first.
			name: "delivery-order-followup-read",
			check: (request) => {
				if (!requestCarriesMarker(request, DELIVERY_LIMIT_WORDS))
					throw new Error("the older follow-up was not delivered");
			},
			reply: {
				content: [
					{ type: "toolCall", id: "delivery-order-read-2", name: "read", arguments: { path: LIMITS_PATH } },
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "delivery-order-reported",
			check: (request) => assertBatchOk(request, "delivery-order-followup-read"),
			reply: { content: [{ type: "text", text: "The older words are noted." }] },
		},
	);
	// The turn's own words ask nothing before its provider request: they are classified where its first tool call settles them.
	world.systemOne.enterPhase("delivery-order-turn", {});
	const orderTurn = session.prompt(DELIVERY_TURN_WORDS);
	await withDeadline(trace, "delivery-order turn reached its provider gate", orderTurnReached.promise);
	// Each queued input is judged in full before it is admitted, the older one first.
	world.systemOne.enterPhase("delivery-order-older-limit", {
		// These judgments also ask the task relation of the standing optional-tool intent.
		optional_tool_task: { kind: "choice", choice: "continue", confidence: 0.97 },
		capabilities_authorized: { kind: "noul", probability: 0.02 },
		changes_model_pools: { kind: "noul", probability: 0.02 },
		local_commits_only: { kind: "noul", probability: 0.97 },
		lifts_delivery_block: { kind: "noul", probability: 0.02 },
		full_handoff: { kind: "noul", probability: 0.02 },
		optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
	});
	await withDeadline(trace, "older limiting follow-up admitted", trace.track(session.followUp(DELIVERY_LIMIT_WORDS)));
	world.systemOne.enterPhase("delivery-order-newer-lift", {
		// These judgments also ask the task relation of the standing optional-tool intent.
		optional_tool_task: { kind: "choice", choice: "continue", confidence: 0.97 },
		capabilities_authorized: { kind: "noul", probability: 0.02 },
		changes_model_pools: { kind: "noul", probability: 0.02 },
		local_commits_only: { kind: "noul", probability: 0.02 },
		lifts_delivery_block: { kind: "noul", probability: 0.97 },
		full_handoff: { kind: "noul", probability: 0.02 },
		optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
	});
	await withDeadline(trace, "newer lifting steer admitted", trace.track(session.steer(DELIVERY_LIFT_WORDS)));
	// The turn's own words are older than both judged inputs, so where its first tool call settles them their owner policy is
	// judged alone; the delivered pair carries its judgments and is applied as judged, asking nothing.
	world.systemOne.enterPhase("delivery-order-turn-policy", {
		capabilities_authorized: { kind: "noul", probability: 0.02 },
		changes_model_pools: { kind: "noul", probability: 0.02 },
		local_commits_only: { kind: "noul", probability: 0.97 },
		lifts_delivery_block: { kind: "noul", probability: 0.02 },
		full_handoff: { kind: "noul", probability: 0.02 },
	});
	releaseOrderTurn.release();
	await withDeadline(trace, "delivery-order turn", orderTurn);
	await withDeadline(trace, "delivery-order queued inputs settled", session.waitForForegroundIdle());
	trace.mark("root", "delivery-order.settled");
	const ownerTurnIndex = (words: string): number =>
		session.messages.findIndex(
			(message) => message.role === "user" && JSON.stringify(message.content).includes(words),
		);
	const liftIndex = ownerTurnIndex(DELIVERY_LIFT_WORDS);
	const limitIndex = ownerTurnIndex(DELIVERY_LIMIT_WORDS);
	expect(
		{ liftDelivered: liftIndex >= 0, limitDelivered: limitIndex >= 0, liftFirst: liftIndex < limitIndex },
		"the newer steer is delivered ahead of the older follow-up",
	).toEqual({ liftDelivered: true, limitDelivered: true, liftFirst: true });
	expect(
		session.localCommitBranch(),
		"an older delivery limit applied after a newer lift does not override the newer owner words",
	).toBeUndefined();

	// Cleanup fault through the real preparation owner: the scoped background call registers a cleanup that throws, and its
	// start is gated so the explicit background handoff wins the race against completion. The operation still runs once, its
	// cleanup failure is retained, and shutdown rejects with that failure. The original hook is called unchanged.
	const cleanupSession = (await world.createRootSession("root", { agentDir: `${world.agentDir}-cleanup` })).session;
	const originalHook = cleanupSession.agent.beforeToolCall;
	cleanupSession.agent.beforeToolCall = async (context, signal) => {
		if (context.toolCall.name === "bash" && commandOf(context.args) === "echo background-cleanup") {
			context.registerCleanup?.(() => {
				throw new Error("scripted cleanup fault");
			});
		}
		return originalHook ? await originalHook(context, signal) : undefined;
	};
	const cleanupGate = createBarrier();
	const cleanupHanded = createBarrier();
	let cleanupTaskId: string | undefined;
	world.shell.enqueue({
		name: "background-cleanup",
		command: "echo background-cleanup",
		cwd: HARNESS_PROJECT_CWD,
		output: "background-cleanup\n",
		exitCode: 0,
		gate: cleanupGate.promise,
	});
	world.systemOne.enterPhase("cleanup", cleanupJudgments);
	world.provider.enqueue(
		"root",
		calls("cleanup-start", [
			{
				id: "cleanup-start-1",
				name: "bash",
				arguments: { command: "echo background-cleanup", background: true },
			},
		]),
		{
			name: "cleanup-started",
			check: (request) => {
				cleanupTaskId = backgroundTaskIdOf(request);
			},
			reply: { content: [{ type: "text", text: "The cleanup check runs in the background." }] },
		},
		{
			name: "cleanup-handoff",
			check: (request) => {
				if (cleanupTaskId === undefined) throw new Error("the cleanup start result carried no task id");
				if (!handoffFor(request, cleanupTaskId)) {
					throw new Error(`the completion of ${cleanupTaskId} did not reach the foreground root`);
				}
				cleanupHanded.release();
			},
			reply: { content: [{ type: "text", text: "The cleanup check is reported." }] },
		},
	);
	const reflectionsBeforeCleanup = world.provider.requests.filter((request) =>
		requestCarriesMarker(request, REFLECTION_CHECKPOINT_MARKER),
	).length;
	await withDeadline(trace, "cleanup start turn", cleanupSession.prompt("Start the cleanup check in the background."));
	await withDeadline(trace, "cleanup foreground settled", cleanupSession.waitForForegroundIdle(), 60_000);
	expect(
		world.provider.requests.filter((request) => requestCarriesMarker(request, REFLECTION_CHECKPOINT_MARKER)).length,
		"a fresh session's start turn makes no reflection due",
	).toBe(reflectionsBeforeCleanup);
	cleanupGate.release();
	await withDeadline(trace, "cleanup handoff", cleanupHanded.promise, 60_000);
	await withDeadline(trace, "cleanup handoff settled", cleanupSession.waitForForegroundIdle(), 60_000);
	cleanupSession.agent.beforeToolCall = originalHook;
	expect(
		world.shell.requests.filter((request) => request.command === "echo background-cleanup"),
		"the cleanup command physically ran once",
	).toHaveLength(1);
	const cleanupShutdown = await world.disposeSessionInBody(cleanupSession);
	const shutdownFailures =
		cleanupShutdown?.error instanceof AggregateError ? cleanupShutdown.error.errors.map(String) : [];
	expect(shutdownFailures, "shutdown rejects with the retained cleanup failure").toEqual([
		expect.stringMatching(/Background tool cleanup failed/),
	]);

	world.provider.enqueue(
		"root",
		{
			name: "reopened-check",
			check: (request) => {
				// The provider receives the restored history: the continuation of the session written before the reopen.
				if (!JSON.stringify(request.context).includes("Still on track.")) {
					throw new Error("the reopened request does not carry the restored history");
				}
				if (longAlias === undefined || legendAliasFor(request, longPath) !== longAlias) {
					throw new Error(`the reopened legend does not map the long path to ${longAlias ?? "its alias"}`);
				}
			},
			reply: { content: [{ type: "text", text: "Reopened and continuing." }] },
		},
		dynamicCalls("restored-alias-read", (request) => {
			const alias = legendAliasFor(request, longPath);
			if (alias === undefined || alias !== longAlias) {
				throw new Error(`the restored legend maps the long path to ${alias ?? "nothing"}, not ${longAlias}`);
			}
			return [{ id: "restored-read-1", name: "read", arguments: { path: alias } }];
		}),
		{
			name: "restored-alias-reported",
			check: (request) => {
				assertBatchOk(request, "restored-alias-read");
				if (!latestBatchResults(request).some((result) => result.text.includes("RETRY_CONFIGURATION"))) {
					throw new Error("the restored alias did not read the long file");
				}
			},
			reply: { content: [{ type: "text", text: "The restored alias reads the same file." }] },
		},
		text("probe-faulty-1", "Probe one."),
		text("probe-faulty-2", "Probe two."),
		text("probe-control-1", "Control one."),
		text("probe-control-2", "Control two."),
	);
	expect(await world.disposeSessionInBody(session), "the main session's disposal must complete").toBeUndefined();
	// Restore: the session file written to the virtual tree is reopened by its owner and continues the same conversation.
	const sessionFile = created.sessionManager.getSessionFile();
	if (sessionFile === undefined) throw new Error("the persisted session has no file");
	expect(world.io.existsSync(sessionFile), "the session file must be written to the virtual tree").toBe(true);
	const reopened = (await world.createRootSession("root", { sessionManager: world.openSessionManager(sessionFile) }))
		.session;
	expect(JSON.stringify(reopened.messages), "the reopened history carries the continuation").toContain(
		"Still on track.",
	);
	await withDeadline(trace, "reopened turn", reopened.prompt("Continue after the reopen."));
	await withDeadline(trace, "restored alias turn", reopened.prompt("Read the retry configuration by its alias."));
	expect(await world.disposeSessionInBody(reopened), "the reopened session must dispose cleanly").toBeUndefined();
	// Factory lifecycle: a prepare failure inside the path-alias store factory, after its migrations, is surfaced as the
	// turn's error and must still close the connection the factory opened. No provider reply is involved: the turn fails
	// before the request is sent, so the probe is not queued.
	const prepareFaulted = (await world.createRootSession("root", { sessionManager: world.createSessionManager() }))
		.session;
	world.guard.failNextSqliteOperation("prepare", "SELECT fingerprint FROM path_alias_scanned");
	await withDeadline(trace, "prepare-faulted turn", prepareFaulted.prompt("Prepare probe."));
	const surfaced = prepareFaulted.messages.at(-1);
	if (
		surfaced?.role !== "assistant" ||
		surfaced.stopReason !== "error" ||
		!surfaced.errorMessage?.includes("Scripted SQLite prepare failure: SELECT fingerprint FROM path_alias_scanned")
	) {
		throw new Error(`the prepare failure did not surface as the turn error: ${JSON.stringify(surfaced)}`);
	}
	world.guard.assertSqliteFaultsConsumed();
	expect(
		await world.disposeSessionInBody(prepareFaulted),
		"the factory failure must not block disposal",
	).toBeUndefined();
	world.guard.assertNoOpenSqliteHandles();
	const faulty = (await world.createRootSession()).session;
	await withDeadline(trace, "faulty probe one", faulty.prompt("Probe one."));
	await withDeadline(trace, "faulty probe two", faulty.prompt("Probe two."));
	world.guard.failNextSqliteOperation("run", "INSERT INTO path_alias_scanned");
	const rejection = await world.disposeSessionInBody(faulty);
	expect(rejection, "a failed required SQL write must reject disposeAndWait").toBeDefined();
	expect(failureText(rejection?.error)).toContain("Scripted SQLite run failure: INSERT INTO path_alias_scanned");
	world.guard.assertSqliteFaultsConsumed();
	world.guard.assertNoOpenSqliteHandles();
	// Negative control: the same release with no fault injected completes cleanly.
	const control = (await world.createRootSession()).session;
	await withDeadline(trace, "control probe one", control.prompt("Control one."));
	await withDeadline(trace, "control probe two", control.prompt("Control two."));
	expect(await world.disposeSessionInBody(control), "a release without a fault must complete").toBeUndefined();
	world.guard.assertNoOpenSqliteHandles();
	// Logical durable cut of a pending native question. The ask is captured at its UI presentation, the live owner is
	// cancelled and settled, and a fresh owner restores only the captured bytes. This qualifies logical restoration of the
	// captured cut: it is not crash, dead-owner or fsync durability.
	const ASK_CALL_ID = "ask-scope-1";
	const scopeQuestion = {
		id: "scope",
		header: "Scope",
		question: "Which limit applies to this run?",
		options: [
			{ label: "Staging", description: "Use the staging limit." },
			{ label: "Production", description: "Use the production limit." },
		],
	};
	const cutPath = harnessPath("durable-cut", "ask-scope.jsonl");
	const presented = createBarrier();
	const holdAsk = createBarrier();
	let presentedRequestId: string | undefined;
	let capturedCut: string | undefined;
	const askRoot = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
	await askRoot.session.bindExtensions({ uiContext: world.humanInput.ui });
	world.provider.enqueue(
		"root",
		calls("ask-scope", [{ id: ASK_CALL_ID, name: "ask_question", arguments: { questions: [scopeQuestion] } }]),
		{
			name: "ask-answer-reported",
			check: (request) => {
				const answered = request.context.messages.some(
					(message) =>
						message.role === "toolResult" &&
						message.toolCallId === ASK_CALL_ID &&
						message.content.some((block) => block.type === "text" && block.text.includes("Staging")),
				);
				if (!answered) throw new Error("the resumed question's answer is not in the provider context");
			},
			reply: { content: [{ type: "text", text: "The staging limit is recorded." }] },
		},
	);
	world.humanInput.enqueue({
		name: "ask-scope-presented",
		gate: holdAsk.promise,
		check: (request) => {
			const sessionFile = askRoot.sessionManager.getSessionFile();
			if (sessionFile === undefined) throw new Error("the asking session has no file to cut");
			if (world.io.existsSync(cutPath)) throw new Error("the durable cut is already written: cuts are immutable");
			const bytes = String(world.io.readFileSync(sessionFile, "utf8"));
			world.io.mkdirSync(harnessPath("durable-cut"), { recursive: true });
			world.io.writeFileSync(cutPath, bytes);
			capturedCut = bytes;
			presentedRequestId = request.requestId;
			presented.release();
		},
		reply: { answers: [], cancelled: true, reason: "interrupted", imageContents: [] },
	});
	const askTurn = askRoot.session.prompt("Ask which limit applies before you edit anything.");
	await withDeadline(trace, "ask presentation reached", presented.promise);
	trace.mark("root", "ask.presented");
	// The live owner is cancelled: the abort settles the external presentation, the join proves it, and only then is the
	// old session disposed. Its presentation is never released, so only the cancellation can end it.
	const aborted = askRoot.session.abort("the owner aborts while the question is pending");
	await withDeadline(trace, "external presentation settled", world.humanInput.join());
	await withDeadline(trace, "old ask owner aborted", aborted);
	await withDeadline(
		trace,
		"aborted ask turn ended",
		askTurn.catch(() => undefined),
	);
	expect(await world.disposeSessionInBody(askRoot.session), "the cut owner disposes cleanly").toBeUndefined();
	holdAsk.release();
	if (capturedCut === undefined || presentedRequestId === undefined) {
		throw new Error("the ask presentation was never captured");
	}
	// The captured cut holds the assistant's call and the native pending question, and no result for that call.
	const parsed = capturedCut
		.split("\n")
		.filter((line) => line.length > 0)
		.map(
			(line) =>
				JSON.parse(line) as {
					type?: string;
					message?: { role?: string; toolCallId?: string; content?: Array<{ type: string; id?: string }> };
				},
		);
	expect(
		parsed.some(
			(entry) =>
				entry.type === "message" &&
				entry.message?.role === "assistant" &&
				(entry.message.content ?? []).some((block) => block.type === "toolCall" && block.id === ASK_CALL_ID),
		),
		"the captured cut holds the assistant's ask_question call",
	).toBe(true);
	expect(
		parsed.some(
			(entry) =>
				entry.type === "message" &&
				entry.message?.role === "toolResult" &&
				entry.message.toolCallId === ASK_CALL_ID,
		),
		"the captured cut holds no result for the ask",
	).toBe(false);
	const pending = getResumableHumanInputSnapshot(world.openSessionManager(cutPath));
	expect(
		{ status: pending?.status, requestId: pending?.request.requestId, toolCallId: pending?.request.toolCallId },
		"the captured cut restores exactly one pending native question",
	).toEqual({ status: "pending", requestId: presentedRequestId, toolCallId: ASK_CALL_ID });
	// The canonical native start of the ask, read from the captured cut: the terminal that closes it must name this tuple.
	const cutEntries = world.openSessionManager(cutPath).getEntries();
	const askStarts = cutEntries.flatMap((entry) =>
		entry.type === "foreground_tool_start" && entry.callId === ASK_CALL_ID ? [entry] : [],
	);
	expect(askStarts, "the cut holds exactly one canonical foreground start for the ask").toHaveLength(1);
	const [askStart] = askStarts;
	if (askStart === undefined) throw new Error("the cut holds no canonical foreground start for the ask");
	const askTuple = {
		requestId: askStart.requestId,
		assistantMessageEntryId: askStart.assistantMessageEntryId,
		callId: askStart.callId,
		toolName: askStart.toolName,
	};
	expect(
		cutEntries.some((entry) => entry.type === "foreground_tool_terminal" && entry.callId === ASK_CALL_ID),
		"the cut holds no terminal for the ask",
	).toBe(false);
	// The fresh owner opens the captured bytes unchanged and answers the same request once; a second resume finds nothing.
	const restored = await world.createRootSession("root", { sessionManager: world.openSessionManager(cutPath) });
	await restored.session.bindExtensions({ uiContext: world.humanInput.ui });
	world.humanInput.enqueue({
		name: "ask-scope-resumed",
		check: (request) => {
			if (request.requestId !== presentedRequestId)
				throw new Error("the resumed presentation names another request");
		},
		reply: {
			answers: [
				{
					id: "scope",
					header: "Scope",
					question: scopeQuestion.question,
					selected: ["Staging"],
					skipped: false,
				},
			],
			cancelled: false,
			imageContents: [],
		},
	});
	expect(
		{
			pending: getResumableHumanInputSnapshot(restored.sessionManager)?.status,
			streaming: restored.session.isStreaming,
		},
		"the restored owner's own view holds the pending question before it resumes",
	).toEqual({ pending: "pending", streaming: false });
	// The branch's native companions of the ask, read from the restored owner's own manager: terminals and tool results.
	const askEntriesNow = () => {
		const entries = restored.sessionManager.getEntries();
		return {
			terminals: entries.flatMap((entry) =>
				entry.type === "foreground_tool_terminal" && entry.callId === ASK_CALL_ID ? [entry] : [],
			),
			results: entries.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === ASK_CALL_ID
					? [entry]
					: [],
			),
		};
	};
	expect(
		await withDeadline(trace, "pending question resumed", restored.session.resumePendingHumanInput()),
		"the restored owner resumes the pending question",
	).toBe(true);
	await withDeadline(trace, "resumed turn settled", restored.session.waitForForegroundIdle());
	expect(
		world.humanInput.requests.filter((request) => request.requestId === presentedRequestId),
		"the same request is presented once to the old owner and once to the restored owner",
	).toHaveLength(2);
	// The native companion: the answer closes the canonical original start through exactly one terminal, and that terminal
	// names the actual tool result entry. No placeholder result stands in for the answer, and the branch stays balanced.
	const askAfterAnswer = askEntriesNow();
	expect(askAfterAnswer.results, "exactly one result answers the question").toHaveLength(1);
	const [askResult] = askAfterAnswer.results;
	expect(
		askResult?.type === "message" &&
			askResult.message.role === "toolResult" &&
			askResult.message.content.some((block) => block.type === "text" && block.text.includes("Staging")),
		"the single result carries the owner's answer, not a placeholder",
	).toBe(true);
	expect(askAfterAnswer.terminals, "exactly one native terminal closes the ask").toHaveLength(1);
	const [askTerminal] = askAfterAnswer.terminals;
	expect(
		{
			requestId: askTerminal?.requestId,
			assistantMessageEntryId: askTerminal?.assistantMessageEntryId,
			callId: askTerminal?.callId,
			toolName: askTerminal?.toolName,
		},
		"the terminal closes the canonical original start captured from the cut",
	).toEqual(askTuple);
	expect(askTerminal?.resultMessageEntryId, "the terminal names the actual answering tool result").toBe(askResult?.id);
	expect(
		restored.sessionManager.inspectSessionLifecycle().balanced,
		"every lifecycle prefix is balanced after the answer",
	).toBe(true);
	expect(
		await withDeadline(trace, "second resume", restored.session.resumePendingHumanInput()),
		"nothing is pending after the answer",
	).toBe(false);
	expect(askEntriesNow(), "the second resume appends no result and no terminal").toEqual(askAfterAnswer);
	expect(await world.disposeSessionInBody(restored.session), "the restored owner disposes cleanly").toBeUndefined();
	// Companion: the same captured prefix, copied unchanged to a fresh path, reopened by a fresh owner with no UI bound. Without
	// a UI there is no presentation, so the resume records the question as unanswered (owner_unavailable): no answer and no
	// authority. The owner's window is not elapsed here; the separate short-window case at the end covers its elapsed path.
	const unavailableCutPath = harnessPath("durable-cut", "ask-scope-unavailable.jsonl");
	expect(world.io.existsSync(unavailableCutPath), "the companion prefix path is fresh").toBe(false);
	world.io.writeFileSync(unavailableCutPath, capturedCut);
	expect(String(world.io.readFileSync(unavailableCutPath, "utf8")), "the companion prefix is the captured bytes").toBe(
		capturedCut,
	);
	const unavailableOwner = await world.createRootSession("root", {
		sessionManager: world.openSessionManager(unavailableCutPath),
	});
	expect(
		getResumableHumanInputSnapshot(unavailableOwner.sessionManager)?.request.requestId,
		"the fresh owner restores the same pending request",
	).toBe(presentedRequestId);
	world.provider.enqueue("root", {
		name: "unavailable-reported",
		check: (request) => {
			const unanswered = request.context.messages.some(
				(message) =>
					message.role === "toolResult" &&
					message.toolCallId === ASK_CALL_ID &&
					message.details !== undefined &&
					typeof message.details === "object" &&
					"reason" in message.details &&
					message.details.reason === "owner_unavailable",
			);
			if (!unanswered) throw new Error("the unavailable owner's result does not record owner_unavailable");
		},
		reply: { content: [{ type: "text", text: "The question stays unanswered without an owner." }] },
	});
	const presentationsBeforeUnavailable = world.humanInput.requests.length;
	expect(
		await withDeadline(trace, "unavailable owner resumes", unavailableOwner.session.resumePendingHumanInput()),
		"the unanswered question is recorded once",
	).toBe(true);
	await withDeadline(trace, "unavailable owner settled", unavailableOwner.session.waitForForegroundIdle());
	expect(world.humanInput.requests.length, "no presentation is made without a UI").toBe(
		presentationsBeforeUnavailable,
	);
	const unavailableResults = unavailableOwner.session.messages.flatMap((message) =>
		message.role === "toolResult" && message.toolCallId === ASK_CALL_ID ? [message] : [],
	);
	expect(unavailableResults, "exactly one result records the unanswered question").toHaveLength(1);
	const [unavailableResult] = unavailableResults;
	expect(
		unavailableResult?.details !== undefined &&
			typeof unavailableResult.details === "object" &&
			"reason" in unavailableResult.details &&
			unavailableResult.details.reason === "owner_unavailable",
		"the recorded result names the owner as unavailable",
	).toBe(true);
	expect(
		unavailableResult?.content.some((block) => block.type === "text" && block.text.includes("Staging")),
		"the unanswered result carries no answer",
	).toBe(false);
	expect(
		await withDeadline(trace, "second unavailable resume", unavailableOwner.session.resumePendingHumanInput()),
		"nothing is pending after the unanswered record",
	).toBe(false);
	expect(
		await world.disposeSessionInBody(unavailableOwner.session),
		"the unavailable owner disposes cleanly",
	).toBeUndefined();
}
