import "./fixtures/harness/builtin-install.ts";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { CheckOptions, LockOptions, UnlockOptions } from "proper-lockfile";
import { expect, it } from "vitest";
import { decisionLedgerFile } from "../src/core/agent-paths.ts";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import { DEFAULT_ACTIVE_TOOL_NAMES } from "../src/core/default-tool-surface.ts";
import { WorkerConversationStore } from "../src/core/delegation/worker-conversation-store.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { readWorkerMailboxRecord, workerMailboxPath } from "../src/core/delegation/worker-mailbox-record.ts";
import { WorkerRecoveryCoordinator } from "../src/core/delegation/worker-recovery-coordinator.ts";
import { getLatestGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import { DecisionLedgerStore } from "../src/core/operator-projection/decision-ledger-store.ts";
import { isCredentialSecretKey, mockCredentialFields } from "../src/core/secrets/credential-content-mock.ts";
import { localFileMutationIntentOperations } from "../src/core/tools/file-mutation-intent.ts";
import type { SessionManager } from "../src/kernel/session/session-manager.ts";
import type { ScriptedRequest, ScriptStep } from "./fixtures/harness/scripted-provider.ts";
import { calls, createBarrier, text } from "./fixtures/harness/scripted-provider.ts";
import {
	HARNESS_PROJECT_CWD,
	type HarnessWorld,
	type HarnessWorldOptions,
	runHarnessWorld,
	withDeadline,
} from "./fixtures/harness/session-fixture.ts";
import { VirtualShell } from "./fixtures/harness/virtual-shell.ts";

/**
 * The real proper-lockfile runs its exclusion and lease logic; only its filesystem is redirected to the
 * active world's virtual fs through the library's own `fs` option, so no lock directory reaches disk.
 * The library's CJS export object is the one production's default import receives, so its functions
 * are rebound in place rather than through an ESM module mock.
 */
interface ProperLockfile {
	lock(file: string, options?: LockOptions): Promise<() => Promise<void>>;
	lockSync(file: string, options?: LockOptions): () => void;
	unlock(file: string, options?: UnlockOptions): Promise<void>;
	unlockSync(file: string, options?: UnlockOptions): void;
	check(file: string, options?: CheckOptions): Promise<boolean>;
	checkSync(file: string, options?: CheckOptions): boolean;
}

const lockfileFs: { current: object | undefined } = { current: undefined };
const properLockfile = createRequire(import.meta.url)("proper-lockfile") as ProperLockfile;
const bindVirtualFs = <T extends object>(options: T | undefined): T => {
	if (lockfileFs.current === undefined) throw new Error("proper-lockfile used outside a harness world");
	return { ...options, fs: lockfileFs.current } as T;
};
for (const name of ["lock", "lockSync", "unlock", "unlockSync", "check", "checkSync"] as const) {
	const original = properLockfile[name] as (file: string, options?: object) => unknown;
	Object.assign(properLockfile, {
		[name]: (file: string, options?: object) => original(file, bindVirtualFs(options)),
	});
}

/** Runs one journey body in a world whose lock directories live in the virtual filesystem. */
async function runJourney(options: HarnessWorldOptions, body: (world: HarnessWorld) => Promise<void>): Promise<void> {
	// Cleared only after runHarnessWorld has awaited every session and store cleanup, which still needs the lock files.
	try {
		await runHarnessWorld(options, async (world) => {
			lockfileFs.current = world.io.nodeFsExports();
			await body(world);
		});
	} finally {
		lockfileFs.current = undefined;
	}
}

const LIMITS_PATH = `${HARNESS_PROJECT_CWD}/src/limits.ts`;

/** One production reference captured at module evaluation; every world must route it to its own tree. */
const CAPTURED_ACCESS = localFileMutationIntentOperations.access;

/**
 * The summarizer's scripted checkpoint. Production verifies it against the session's facts (read/edited files,
 * the active request, mandatory rules, open problems, done actions) and accepts it only when it carries them.
 */
const COMPACTION_SUMMARY = [
	"## Active Task",
	"User: Read /harness/project/src/limits.ts, change MAX_RETRIES from 3 to 5, and remember that I prefer tabs over spaces.",
	"",
	"### Mandatory Rules",
	"(none)",
	"",
	"## Working Set",
	"- /harness/project/src/limits.ts — EDIT",
	"",
	"## Files",
	"- /harness/project/src/limits.ts",
	"",
	"## Open Problems",
	"(none)",
	"",
	"## Done",
	"1. READ /harness/project/src/limits.ts",
	"2. EDIT /harness/project/src/limits.ts",
	"3. MEMORY saved the owner's tab preference to USER.md",
	"",
	"## Key Decisions",
	"- MAX_RETRIES is set to 5 as the owner asked.",
	"",
	"## Constraints & Preferences",
	"- The owner prefers tabs over spaces.",
	"",
	"## Critical Context",
	"- /harness/project/src/limits.ts holds MAX_RETRIES = 5 after the edit.",
].join("\n");

/** Every message of a failure, including the members of an aggregate, so a wrapped diagnostic is still matched. */
function failureText(error: unknown): string {
	if (error instanceof AggregateError) return error.errors.map(failureText).join(" | ");
	return error instanceof Error ? error.message : String(error);
}

/** One line per tool result the production loop recorded, so an assertion failure names the failing call. */
function toolOutcomes(session: AgentSession): string {
	return session.messages
		.flatMap((message) => {
			if (message.role !== "toolResult") return [];
			const text = message.content.map((block) => (block.type === "text" ? block.text : block.type)).join(" ");
			return [`${message.toolName} isError=${message.isError}: ${text.slice(0, 900)}`];
		})
		.join("\n");
}

it("standalone root conversation: greeting, task with tools and memory, compaction, queued input, continuation", async () => {
	await runJourney(
		{
			name: "journey-1",
			files: {
				[LIMITS_PATH]: "export const MAX_RETRIES = 3;\n",
				[`${HARNESS_PROJECT_CWD}/src/features/retry/configuration/limits.ts`]:
					'export const RETRY_CONFIGURATION = "long";\n',
			},
			// Guarded edge: no standing grant for destructive filesystem operations, so the operator is asked.
			settings: { edge: { allow: [] } },
		},
		async (world) => {
			const trace = world.trace;
			let mainSession: AgentSession | undefined;
			// The operation table captured at module evaluation must reach the virtual tree, not the host.
			await expect(localFileMutationIntentOperations.access(LIMITS_PATH, constants.R_OK)).resolves.toBeUndefined();
			await expect(
				localFileMutationIntentOperations.access(`${HARNESS_PROJECT_CWD}/missing.ts`, constants.R_OK),
			).rejects.toThrow("virtual filesystem");
			// Exclusive copy, as the production edit and write paths issue it: an existing destination is refused and
			// keeps its bytes; an absent destination is created in the virtual tree.
			const copySource = `${HARNESS_PROJECT_CWD}/src/copy-source.ts`;
			world.io.seed(copySource, "export const COPIED = true;\n");
			await expect(
				localFileMutationIntentOperations.copyFileExclusive(copySource, LIMITS_PATH),
			).rejects.toMatchObject({
				code: "EEXIST",
			});
			expect(world.io.readFileSync(LIMITS_PATH, "utf8")).toBe(ORIGINAL_LIMITS);
			const copyTarget = `${HARNESS_PROJECT_CWD}/src/copy-target.ts`;
			await expect(
				localFileMutationIntentOperations.copyFileExclusive(copySource, copyTarget),
			).resolves.toBeUndefined();
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
				database.exec(`ATTACH DATABASE '${HARNESS_PROJECT_CWD}/evil.db' AS evil`);
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
				const vacuum = probeSql(`VACUUM INTO '${HARNESS_PROJECT_CWD}/vacuum-target.db'`);
				expect(
					{ statement: "VACUUM INTO", error: vacuum.error, labels: vacuum.labels },
					"VACUUM INTO is refused by the RAM authorizer",
				).toEqual({
					statement: "VACUUM INTO",
					error: "Error: authorization denied",
					labels: ["sqlite.attach"],
				});
				const extension = probeSql(`SELECT load_extension('${HARNESS_PROJECT_CWD}/missing.so')`);
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
			const statePath = `${HARNESS_PROJECT_CWD}/state.db`;
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
				expect(
					reader.prepare("PRAGMA busy_timeout").get(),
					"busy_timeout is supported on the read-only handle",
				).toEqual({
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
			world.systemOne.enterPhase("task", {
				capabilities_authorized: { kind: "noul", probability: 0.02 },
				changes_model_pools: { kind: "noul", probability: 0.02 },
				local_commits_only: { kind: "noul", probability: 0.02 },
				lifts_delivery_block: { kind: "noul", probability: 0.02 },
				full_handoff: { kind: "noul", probability: 0.02 },
				// owner_messages[0] is still the greeting, and the owner names no optional tool in any message.
				carries_0: { kind: "noul", probability: 0.97 },
				optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
			});
			trace.mark("root", "task.submit");
			await withDeadline(
				trace,
				"task turn",
				session.prompt(
					`Read ${LIMITS_PATH}, change MAX_RETRIES from 3 to 5, and remember that I prefer tabs over spaces.`,
				),
			);
			trace.mark("root", "task.reply");
			// The add is durable: its managed file holds the saved entry, bytes on disk, not only a success flag.
			expect(world.io.readFileSync(`${world.agentDir}/USER.md`, "utf8")).toContain(
				"The owner prefers tabs over spaces.",
			);
			expect(world.io.readFileSync(LIMITS_PATH, "utf8"), toolOutcomes(session)).toContain("MAX_RETRIES = 5");

			// The summary request holds at its gate. The follow-up is queued while compaction is pending, and only
			// the admission event opens the gate: the queued prompt's own promise resolves after its turn, later.
			const compaction = session.compact("Keep the limits task.");
			await withDeadline(trace, "compaction started", compactionStarted.promise);
			trace.mark("root", "compaction.started");
			const queuedTurn = session.prompt("Also keep the tab preference in mind.", { streamingBehavior: "followUp" });
			await withDeadline(trace, "follow-up admitted to the queue", followUpAdmitted.promise);
			trace.mark("root", "queued-input.admitted");
			compactionGate.release();
			const compactionResult = await withDeadline(trace, "compaction result", compaction);
			trace.mark("root", "compaction.returned");
			await withDeadline(trace, "queued follow-up turn", queuedTurn);
			trace.mark("root", "queued-input.delivered");

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

			expect(messageEnds).toContain("user");
			expect(messageEnds).toContain("assistant");

			world.provider.enqueue(
				"root",
				calls("memory-list", [
					{ id: "memory-list-1", name: "memory", arguments: { action: "list", target: "user" } },
				]),
				{
					name: "memory-list-reply",
					check: (request) => {
						const listed = latestBatchResults(request).find((result) => result.toolName === "memory");
						if (!listed?.text.includes("The owner prefers tabs over spaces.")) {
							throw new Error(
								`the fresh memory read did not return the saved entry: ${listed?.text ?? "no result"}`,
							);
						}
					},
					reply: { content: [{ type: "text", text: "Your preference is saved." }] },
				},
			);
			world.systemOne.enterPhase("memory-read", {
				changes_model_pools: { kind: "noul", probability: 0.02 },
				local_commits_only: { kind: "noul", probability: 0.02 },
				lifts_delivery_block: { kind: "noul", probability: 0.02 },
				full_handoff: { kind: "noul", probability: 0.02 },
				optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
				capabilities_authorized: { kind: "noul", probability: 0.02 },
			});
			await withDeadline(trace, "memory read-back turn", session.prompt("Read back the preference you saved."));
			trace.mark("root", "memory.read-back");

			// Long project path after compaction. The first read names the raw path; the minted alias then appears in the
			// request-visible PATH ALIASES legend, and the model reads through that alias. The short limits.ts stays unaliased.
			const longPath = `${HARNESS_PROJECT_CWD}/src/features/retry/configuration/limits.ts`;
			let longAlias: string | undefined;
			world.systemOne.enterPhase("long-path", {
				changes_model_pools: { kind: "noul", probability: 0.02 },
				local_commits_only: { kind: "noul", probability: 0.02 },
				lifts_delivery_block: { kind: "noul", probability: 0.02 },
				full_handoff: { kind: "noul", probability: 0.02 },
				optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
				capabilities_authorized: { kind: "noul", probability: 0.02 },
			});
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
			await withDeadline(
				trace,
				"long path turn",
				session.prompt(`Read ${longPath} and summarize the retry configuration.`),
			);
			if (longAlias === undefined) throw new Error("no alias was observed for the long path");
			trace.mark("root", "long-path.read");
			// The alias is persisted in the session's SQL alias store, not only in the transcript: read it back through a read-only
			// connection, then close that connection before the body continues.
			const aliasStore = `${world.agentDir}/work/context/sessions/${created.sessionManager.getSessionId()}/index/runtime.sqlite`;
			if (!world.io.existsSync(aliasStore)) throw new Error(`the alias store was not written: ${aliasStore}`);
			const storedAliases = readPathAliases(aliasStore);
			expect(storedAliases, "the alias store holds the minted mapping").toContainEqual({
				full_path: longPath,
				alias_id: longAlias,
			});

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
							throw new Error(
								`the denied command was not refused by the operator: ${denied?.text ?? "no result"}`,
							);
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
						content: [
							{ type: "toolCall", id: "bash-approved-1", name: "bash", arguments: { command: "rm -rf .git" } },
						],
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
			expect(askedOperations, "the operator is asked for each attempt").toHaveLength(2);
			expect(askedOperations.every((operation) => operation.includes("rm -rf .git"))).toBe(true);

			// Cancellation. The turn is held at its provider gate until the operator aborts it: the abort persists the turn
			// as aborted, the current input is answered by the next turn, the held reply never reaches the transcript, and
			// the cancelled root starts no worker.
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
				text("current-input-reply", "Current input handled."),
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
			await withDeadline(trace, "current input after the cancel", session.prompt("Current input after the cancel."));
			trace.mark("root", "current-input.reply");
			const transcript = JSON.stringify(session.messages);
			expect(transcript).toContain("Current input handled.");
			expect(transcript, "a cancelled turn's held reply must not reach the transcript").not.toContain(
				"This reply is never delivered.",
			);
			expect(delegateResultTexts(session), "a cancelled root starts no worker").toEqual([]);
			expect(world.provider.reached.filter((step) => !step.startsWith("root:"))).toEqual([]);

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
			explicitShell.enqueue({
				name: "direct-explicit",
				command: "echo direct-explicit",
				cwd: HARNESS_PROJECT_CWD,
				output: "direct-explicit\n",
				exitCode: 0,
			});
			const shellRequestsBeforePrewarm = world.shell.requests.length;
			await withDeadline(trace, "prewarm settled", session.prewarmShell());
			expect(world.shell.requests.length, "prewarm with a configured backend runs nothing").toBe(
				shellRequestsBeforePrewarm,
			);
			const directDefault = await withDeadline(
				trace,
				"direct default bash",
				session.executeBash("echo direct-default"),
			);
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
			expect(world.shell.reached).toEqual(
				expect.arrayContaining(["race-abort-during-check", "race-abort-after-output"]),
			);

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
			expect(laneKeyFields, "the api key value is masked by key classification").not.toContain(
				"opaque-key-value-42",
			);
			expect(mockCredentialFields('{"password":"hunter2-secret"}'), "the password value is masked").not.toContain(
				"hunter2-secret",
			);
			const tokenLaneKey = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
			expect(
				mockCredentialFields(`{"laneKey":"${tokenLaneKey}"}`),
				"a token-shaped lane key is masked",
			).not.toContain(tokenLaneKey);

			// The background turns ask no judgment of their own; the cleanup turns ask the owner-message question.
			const backgroundJudgments = {
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
						expect(
							session.getActiveToolNames(),
							"tool_task is active, so the handoff path is admitted",
						).toContain("tool_task");
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

			// Cleanup fault through the real preparation owner: the scoped background call registers a cleanup that throws, and its
			// start is gated so the explicit background handoff wins the race against completion. The operation still runs once, its
			// cleanup failure is retained, and shutdown rejects with that failure. The original hook is called unchanged.
			const cleanupSession = (await world.createRootSession("root", { agentDir: `${world.agentDir}-cleanup` }))
				.session;
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
			await withDeadline(
				trace,
				"cleanup start turn",
				cleanupSession.prompt("Start the cleanup check in the background."),
			);
			await withDeadline(trace, "cleanup foreground settled", cleanupSession.waitForForegroundIdle(), 60_000);
			expect(
				world.provider.requests.filter((request) => requestCarriesMarker(request, REFLECTION_CHECKPOINT_MARKER))
					.length,
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
			const reopened = (
				await world.createRootSession("root", { sessionManager: world.openSessionManager(sessionFile) })
			).session;
			expect(JSON.stringify(reopened.messages), "the reopened history carries the continuation").toContain(
				"Still on track.",
			);
			await withDeadline(trace, "reopened turn", reopened.prompt("Continue after the reopen."));
			await withDeadline(
				trace,
				"restored alias turn",
				reopened.prompt("Read the retry configuration by its alias."),
			);
			expect(
				await world.disposeSessionInBody(reopened),
				"the reopened session must dispose cleanly",
			).toBeUndefined();
			// Factory lifecycle: a prepare failure inside the path-alias store factory, after its migrations, is surfaced as the
			// turn's error and must still close the connection the factory opened. No provider reply is involved: the turn fails
			// before the request is sent, so the probe is not queued.
			const prepareFaulted = (
				await world.createRootSession("root", { sessionManager: world.createSessionManager() })
			).session;
			world.guard.failNextSqliteOperation("prepare", "SELECT fingerprint FROM path_alias_scanned");
			await withDeadline(trace, "prepare-faulted turn", prepareFaulted.prompt("Prepare probe."));
			const surfaced = prepareFaulted.messages.at(-1);
			if (
				surfaced?.role !== "assistant" ||
				surfaced.stopReason !== "error" ||
				!surfaced.errorMessage?.includes(
					"Scripted SQLite prepare failure: SELECT fingerprint FROM path_alias_scanned",
				)
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
		},
	);
}, 120_000);

/** Text of every `delegate` tool result the session recorded, in order (structured, not line-prefix matched). */
function delegateResultTexts(session: AgentSession): string[] {
	return session.messages.flatMap((message) => {
		if (message.role !== "toolResult" || message.toolName !== "delegate") return [];
		return [message.content.map((block) => (block.type === "text" ? block.text : block.type)).join("\n")];
	});
}

/** The stable agent id production assigned to the worker that runs on `track` (its effective model). */
function agentIdForTrack(request: ScriptedRequest, track: string): string {
	for (const message of request.context.messages) {
		if (message.role !== "toolResult" || message.toolName !== "delegate") continue;
		for (const block of message.content) {
			if (block.type !== "text") continue;
			const match = new RegExp(`stable agentId (\\S+?),[^\\n]*effective model harness-script/${track}\\b`).exec(
				block.text,
			);
			if (match?.[1]) return match[1];
		}
	}
	throw new Error(`No started agent is running on track ${track} in the projected request`);
}

/** The most recent stable agent id production assigned to a worker on `track` (the one a later start created). */
function latestAgentIdForTrack(request: ScriptedRequest, track: string): string {
	let found: string | undefined;
	for (const message of request.context.messages) {
		if (message.role !== "toolResult" || message.toolName !== "delegate") continue;
		for (const block of message.content) {
			if (block.type !== "text") continue;
			const pattern = new RegExp(`stable agentId (\\S+?),[^\\n]*effective model harness-script/${track}\\b`, "g");
			for (const match of block.text.matchAll(pattern)) found = match[1];
		}
	}
	if (found === undefined) throw new Error(`No started agent is running on track ${track} in the projected request`);
	return found;
}

it("orchestration: goal, three delegated agents, blocked report, follow-up reply, goal completion", async () => {
	await runJourney(
		{
			name: "journey-2",
			files: { [LIMITS_PATH]: "export const MAX_RETRIES = 3;\n" },
			// A clean checkout on main: a fresh writer worker gets its own worktree lane (dirty checkouts fall back to shared).
			repository: { committed: { "src/limits.ts": "export const MAX_RETRIES = 3;\n" } },
			settings: { defaultTools: [...DEFAULT_ACTIVE_TOOL_NAMES, "worktree_sync"], edge: { allow: [] } },
		},
		async (world) => {
			const trace = world.trace;
			const allReported = createBarrier();
			const workersMayRead = createBarrier();
			let blockedAgentId: string | undefined;
			let mainBeforeApproval: string | undefined;
			const scratchDir = `${HARNESS_PROJECT_CWD}/scratch`;
			const scratchGit = `${scratchDir}/.git`;
			let orchestrationRoot: AgentSession | undefined;
			// The same captured reference, in a second world: its own file resolves, and the first world's file does not.
			await expect(CAPTURED_ACCESS(LIMITS_PATH, constants.R_OK)).resolves.toBeUndefined();
			await expect(CAPTURED_ACCESS(`${HARNESS_PROJECT_CWD}/src/copy-source.ts`, constants.R_OK)).rejects.toThrow(
				"virtual filesystem",
			);

			world.provider.enqueue(
				"root",
				calls("goal-start", [
					{
						id: "goal-1",
						name: "goal",
						arguments: { action: "start", goalId: "limits-goal", userGoal: "Set MAX_RETRIES to 5." },
					},
				]),
				calls("goal-requirement", [
					{ id: "goal-2", name: "goal", arguments: { action: "add_requirement", text: "MAX_RETRIES equals 5" } },
				]),
				calls("dispatch-three", [
					{
						id: "dispatch-a",
						name: "delegate",
						arguments: {
							action: "start",
							model: { provider: "harness-script", modelId: "worker-a" },
							instructions: "Inspect the limits file and report whether the retry count is confirmed.",
						},
					},
					{
						id: "dispatch-b",
						name: "delegate",
						arguments: {
							action: "start",
							model: { provider: "harness-script", modelId: "worker-b" },
							instructions: "Inspect the limits file and report the current value.",
						},
					},
					{
						id: "dispatch-c",
						name: "delegate",
						arguments: {
							action: "start",
							model: { provider: "harness-script", modelId: "worker-c" },
							instructions: "Inspect the limits file and report the current value.",
						},
					},
				]),
				calls("status-overlap", [
					{ id: "status-overlap-1", name: "worktree_sync", arguments: { action: "status" } },
				]),
				{
					name: "overlap-checked",
					check: (request) => {
						const root = orchestrationRoot;
						if (root === undefined) throw new Error("the root session is not created yet");
						const lanes = lanesOf(lastToolResultDetails(root, "worktree_sync"));
						const bound = lanes.flatMap((lane) => (lane.boundLaneId === undefined ? [] : [lane.boundLaneId]));
						const agents = ["worker-a", "worker-b", "worker-c"].map((track) => agentIdForTrack(request, track));
						if (bound.length !== agents.length || !agents.every((id) => bound.includes(id))) {
							throw new Error(`worker lanes are not bound to their agents: ${JSON.stringify(lanes)}`);
						}
						const paths = lanes.map((lane) => lane.worktreePath);
						if (new Set(paths).size !== paths.length)
							throw new Error(`lane checkouts collide: ${paths.join(", ")}`);
						// Approval while the workers are active: a harmless scratch .git is removed only after the operator approves it.
						mainBeforeApproval = world.git.refSha("refs/heads/main");
						world.io.mkdirSync(scratchDir, { recursive: true });
						world.io.writeFileSync(scratchGit, "gitdir: nowhere\n");
					},
					reply: {
						content: [
							{
								type: "toolCall",
								id: "bash-denied-1",
								name: "bash",
								arguments: { command: "rm -rf scratch/.git" },
							},
						],
						stopReason: "toolUse",
					},
				},
				{
					name: "approval-denied-reported",
					check: (request) => {
						const denied = latestBatchResults(request).find((result) => result.toolName === "bash");
						if (!denied?.isError || !denied.text.includes("declined")) {
							throw new Error(
								`the denied removal was not refused by the operator: ${denied?.text ?? "no result"}`,
							);
						}
						if (world.shell.requests.length !== 0 || !world.io.existsSync(scratchGit)) {
							throw new Error("a denied removal reached the shell or removed the scratch .git");
						}
					},
					reply: {
						content: [
							{ type: "toolCall", id: "read-between-approval", name: "read", arguments: { path: LIMITS_PATH } },
						],
						stopReason: "toolUse",
					},
				},
				{
					name: "approval-read-between",
					check: (request) => assertBatchOk(request, "approval-denied-reported"),
					reply: {
						content: [
							{
								type: "toolCall",
								id: "bash-approved-1",
								name: "bash",
								arguments: { command: "rm -rf scratch/.git" },
							},
						],
						stopReason: "toolUse",
					},
				},
				{
					name: "approval-approved-reported",
					check: (request) => {
						assertBatchOk(request, "approval-read-between");
						if (world.shell.requests.length !== 1 || world.io.existsSync(scratchGit)) {
							throw new Error("the approved removal did not run exactly once");
						}
						if (
							world.git.refSha("refs/heads/main") !== mainBeforeApproval ||
							!world.io.existsSync(`${HARNESS_PROJECT_CWD}/.git`)
						) {
							throw new Error("the approval touched the main repository");
						}
						workersMayRead.release();
					},
					reply: { content: [{ type: "text", text: "Dispatched three agents; waiting for their reports." }] },
				},
				{
					name: "follow-up-blocked-agent",
					reply: (request) => {
						const blockedAgent = agentIdForTrack(request, "worker-a");
						blockedAgentId = blockedAgent;
						return {
							content: [
								{
									type: "toolCall",
									id: "follow-a",
									name: "delegate",
									arguments: {
										action: "follow_up",
										agentId: blockedAgent,
										message: "The confirmed retry count is 5.",
									},
								},
							],
							stopReason: "toolUse",
						};
					},
				},
				text("root-after-follow-up", "Reply sent to the blocked agent."),
				// Terminal handoffs may coalesce into fewer root turns, so the step stays at the head until the
				// production context carries every worker's successful terminal handoff.
				{
					name: "reports-received",
					until: (request) => {
						const handoffs = request.context.messages
							.flatMap((message) =>
								message.role === "user" && typeof message.content !== "string" ? message.content : [],
							)
							.map((block) => (block.type === "text" ? block.text : ""))
							.filter((text) => text.includes("Background worker terminal handoff"))
							.join("\n");
						const done = [
							/- mailbox-turn-[0-9a-f]+: succeeded reason=worker_completed[\s\S]*?Retry count confirmed as 5\./,
							/- worker-2: succeeded/,
							/- worker-3: succeeded/,
						].every((pattern) => pattern.test(handoffs));
						if (done) allReported.release();
						return done;
					},
					reply: (request) => {
						const handoffs = JSON.stringify(request.context.messages);
						const done = /- worker-3: succeeded/.test(handoffs);
						return {
							content: [
								{
									type: "text",
									text: done ? "All three agents reported." : "Waiting for the remaining reports.",
								},
							],
						};
					},
				},
			);
			world.provider.enqueue(
				"worker-a",
				{
					name: "worker-a-read",
					gate: workersMayRead.promise,
					reply: {
						content: [{ type: "toolCall", id: "wa-read", name: "read", arguments: { path: LIMITS_PATH } }],
						stopReason: "toolUse",
					},
				},
				calls("worker-a-blocked", [
					{
						id: "wa-report-blocked",
						name: "submit_report",
						arguments: {
							status: "blocked",
							summary: "Need the owner to confirm the retry count.",
							blockers: ["Owner must confirm the retry count."],
						},
					},
				]),
				calls("worker-a-resumed", [
					{
						id: "wa-report",
						name: "submit_report",
						arguments: { status: "completed", summary: "Retry count confirmed as 5." },
					},
				]),
			);
			world.provider.enqueue(
				"worker-b",
				{
					name: "worker-b-read",
					gate: workersMayRead.promise,
					reply: {
						content: [{ type: "toolCall", id: "wb-read", name: "read", arguments: { path: LIMITS_PATH } }],
						stopReason: "toolUse",
					},
				},
				calls("worker-b-report", [
					{
						id: "wb-report",
						name: "submit_report",
						arguments: { status: "completed", summary: "Current value is 3." },
					},
				]),
			);
			world.provider.enqueue(
				"worker-c",
				{
					name: "worker-c-read",
					gate: workersMayRead.promise,
					reply: {
						content: [{ type: "toolCall", id: "wc-read", name: "read", arguments: { path: LIMITS_PATH } }],
						stopReason: "toolUse",
					},
				},
				calls("worker-c-report", [
					{
						id: "wc-report",
						name: "submit_report",
						arguments: { status: "completed", summary: "Current value is 3." },
					},
				]),
			);

			const created = await world.createRootSession();
			const session = created.session;
			orchestrationRoot = session;
			const warnings: string[] = [];
			session.subscribe((event) => {
				if (event.type === "warning") warnings.push(event.message);
			});
			trace.mark("root", "session.created");

			// The goal turn: the owner's request is not small talk and names no tool or delivery rule; before any
			// worker reports, no action has accomplished the step, so postflight holds the plan on `continue`.
			world.systemOne.enterPhase("orchestration-goal", {
				capabilities_authorized: { kind: "noul", probability: 0.02 },
				changes_model_pools: { kind: "noul", probability: 0.02 },
				local_commits_only: { kind: "noul", probability: 0.02 },
				lifts_delivery_block: { kind: "noul", probability: 0.02 },
				full_handoff: { kind: "noul", probability: 0.02 },
				optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
				action_accomplished_step: { kind: "noul", probability: 0.02 },
				conclusions_supported: { kind: "noul", probability: 0.97 },
				scope_violation: { kind: "noul", probability: 0.02 },
				unrelated_behavior_change: { kind: "noul", probability: 0.02 },
				replan_required: { kind: "noul", probability: 0.02 },
				next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
			});
			trace.mark("root", "owner.task");
			// The operator answers the destructive-removal confirmation: deny the first attempt, approve the revised one.
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
			world.shell.enqueue({
				name: "approved-scratch-removal",
				command: "rm -rf scratch/.git",
				cwd: HARNESS_PROJECT_CWD,
				output: "",
				exitCode: 0,
				effect: () => {
					world.io.rmSync(scratchGit, { force: true });
				},
			});
			await withDeadline(
				trace,
				"orchestration task turn",
				session.prompt(
					"Goal: set MAX_RETRIES to 5 in the limits file. Dispatch agents to confirm it and report back.",
				),
			);
			trace.mark("root", "owner.task.settled");
			session.setEdgeConfirmation(undefined);
			expect(
				{ ...confirmations, decisionsLeft: decisions.length },
				"every asked confirmation settled, none in flight, no decision left over",
			).toEqual({ asked: askedOperations.length, inFlight: 0, settled: askedOperations.length, decisionsLeft: 0 });
			expect(askedOperations, "the operator is asked once per attempt").toHaveLength(2);
			expect(askedOperations.every((operation) => operation.includes("rm -rf scratch/.git"))).toBe(true);
			// Delegation admission is observable as soon as the dispatch turn settles: every start must be admitted.
			const admissions = delegateResultTexts(session);
			expect(
				admissions.map((text) => text.includes("delegate started (running)")),
				`delegate admission outcomes\n${toolOutcomes(session)}\nwarnings: ${warnings.join(" | ")}`,
			).toEqual([true, true, true]);

			await withDeadline(trace, "all agent reports delivered", allReported.promise, 30_000).catch(
				(error: unknown) => {
					throw new Error(`${error instanceof Error ? error.message : String(error)}\n${toolOutcomes(session)}`);
				},
			);
			trace.mark("root", "all-reports-received");
			// Durable receipt, read from the persisted mailbox file rather than from scripted claims: the follow-up the operator sent
			// to the blocked agent is delivered, and its control receipt is recorded in that agent's mailbox on disk.
			if (blockedAgentId === undefined) throw new Error("the blocked agent's follow-up was never sent");
			const mailboxFile = workerMailboxPath(world.agentDir, created.sessionManager.getSessionId(), blockedAgentId);
			expect(world.io.existsSync(mailboxFile), "the worker mailbox is written to the virtual tree").toBe(true);
			const { mailbox } = readWorkerMailboxRecord(mailboxFile);
			const followUp = mailboxMessagesOf(mailbox).find(
				(message) => message.content === "The confirmed retry count is 5.",
			);
			expect(followUp?.deliveredAt, "the follow-up is delivered in the persisted mailbox").toEqual(
				expect.any(String),
			);
			expect(
				receiptsOf(mailbox).filter(
					(receipt) => receipt.messageId === followUp?.messageId && receipt.kind === "control",
				),
				"the follow-up has exactly one durable control receipt",
			).toHaveLength(1);
			// The reports release the barrier while the root turn that answers them is still finishing; the operator waits for idle.
			await withDeadline(trace, "root idle after the reports", session.waitForForegroundIdle());

			// Steering phase. The fourth agent is held at its provider gate until the interrupt is in place, so the halt is taken
			// at its next request boundary. Its handoff reports `worker_interrupted`; retirement keeps the binding and transcript.
			const fourthReached = createBarrier();
			const fourthGate = createBarrier();
			const handedOff = createBarrier();
			const retired = createBarrier();
			world.provider.enqueue(
				"worker-c",
				{
					name: "fourth-read",
					check: () => fourthReached.release(),
					gate: fourthGate.promise,
					reply: {
						content: [{ type: "toolCall", id: "fourth-read-1", name: "read", arguments: { path: LIMITS_PATH } }],
						stopReason: "toolUse",
					},
				},
				text("fourth-halted", "Halted before a value was confirmed."),
			);
			world.provider.enqueue(
				"root",
				calls("start-fourth", [
					{
						id: "start-4",
						name: "delegate",
						arguments: {
							action: "start",
							model: { provider: "harness-script", modelId: "worker-c" },
							instructions: "Read the limits file and report the value.",
						},
					},
				]),
				text("fourth-started", "Fourth agent started and running."),
				dynamicCalls(
					"interrupt-fourth",
					(request) => [
						{
							id: "interrupt-4",
							name: "delegate",
							arguments: {
								action: "interrupt",
								agentId: latestAgentIdForTrack(request, "worker-c"),
								message: "The operator halts the fourth agent.",
							},
						},
					],
					(request) => assertBatchOk(request, "start-fourth"),
				),
				{
					name: "interrupt-sent",
					check: (request) => {
						assertBatchOk(request, "interrupt-fourth");
						const sent = latestBatchResults(request).find((result) => result.toolName === "delegate");
						if (!sent?.text.includes("halt requested"))
							throw new Error(`the interrupt was not accepted: ${sent?.text ?? "no result"}`);
						fourthGate.release();
					},
					reply: { content: [{ type: "text", text: "Interrupt sent." }] },
				},
				dynamicCalls(
					"retire-fourth",
					(request) => [
						{
							id: "retire-4",
							name: "delegate",
							arguments: { action: "retire", agentId: latestAgentIdForTrack(request, "worker-c") },
						},
					],
					(request) => {
						if (!JSON.stringify(request.context.messages).includes("worker_interrupted")) {
							throw new Error("the halted agent's handoff does not report worker_interrupted");
						}
						handedOff.release();
					},
				),
				{
					name: "retired",
					check: (request) => {
						assertBatchOk(request, "retire-fourth");
						const gone = latestBatchResults(request).find((result) => result.toolName === "delegate");
						if (!gone?.text.includes("retired"))
							throw new Error(`the retirement was not recorded: ${gone?.text ?? "no result"}`);
						retired.release();
					},
					reply: { content: [{ type: "text", text: "Fourth agent retired." }] },
				},
			);
			world.systemOne.enterPhase("steer-start", {
				capabilities_authorized: { kind: "noul", probability: 0.02 },
				changes_model_pools: { kind: "noul", probability: 0.02 },
				local_commits_only: { kind: "noul", probability: 0.02 },
				lifts_delivery_block: { kind: "noul", probability: 0.02 },
				full_handoff: { kind: "noul", probability: 0.02 },
				optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
				action_accomplished_step: { kind: "noul", probability: 0.02 },
				conclusions_supported: { kind: "noul", probability: 0.97 },
				scope_violation: { kind: "noul", probability: 0.02 },
				unrelated_behavior_change: { kind: "noul", probability: 0.02 },
				replan_required: { kind: "noul", probability: 0.02 },
				next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
				step_relevant: { kind: "noul", probability: 0.97 },
				evidence_sufficient_to_act: { kind: "noul", probability: 0.97 },
				unsupported_assumption_present: { kind: "noul", probability: 0.02 },
				route: { kind: "choice", choice: "inspect", confidence: 0.97 },
			});
			await withDeadline(trace, "fourth agent started", session.prompt("Start a fourth agent on the third track."));
			await withDeadline(trace, "fourth agent reached its gate", fourthReached.promise);
			world.systemOne.enterPhase("steer-interrupt", {
				capabilities_authorized: { kind: "noul", probability: 0.02 },
				changes_model_pools: { kind: "noul", probability: 0.02 },
				local_commits_only: { kind: "noul", probability: 0.02 },
				lifts_delivery_block: { kind: "noul", probability: 0.02 },
				full_handoff: { kind: "noul", probability: 0.02 },
				optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
				action_accomplished_step: { kind: "noul", probability: 0.02 },
				conclusions_supported: { kind: "noul", probability: 0.97 },
				scope_violation: { kind: "noul", probability: 0.02 },
				unrelated_behavior_change: { kind: "noul", probability: 0.02 },
				replan_required: { kind: "noul", probability: 0.02 },
				next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
				step_relevant: { kind: "noul", probability: 0.97 },
				evidence_sufficient_to_act: { kind: "noul", probability: 0.97 },
				unsupported_assumption_present: { kind: "noul", probability: 0.02 },
				route: { kind: "choice", choice: "inspect", confidence: 0.97 },
			});
			await withDeadline(
				trace,
				"operator interrupts the fourth agent",
				session.prompt("Interrupt the fourth agent."),
			);
			await withDeadline(trace, "interrupted agent handed off", handedOff.promise, 60_000);
			await withDeadline(trace, "interrupted agent retired", retired.promise, 60_000);

			// Substrate, asserted rather than assumed. The root runs the System One objective loop with its controller bound, and
			// keeps goal and delegate on its foreground surface. This journey has no orchestration profile, so no profile validator
			// trims the root: the goal tools stay available and the loop is not downgraded to a reply-only loop.
			// The operator's manual goal continuation (/goal-continue): one bounded System One objective cycle, live.
			world.systemOne.enterPhase("objective-cycle", {
				objective_coherent: { kind: "noul", probability: 0.97 },
				ambiguity_severity: { kind: "score", level: 0, confidence: 1 },
				missing_information: { kind: "noul", probability: 0.02 },
				acceptance_complete: { kind: "noul", probability: 0.97 },
				grounding_sufficient: { kind: "noul", probability: 0.97 },
				work_remaining: { kind: "noul", probability: 0.97 },
				missing_work_class: { kind: "choice", choice: "implement", confidence: 0.97 },
				evidence_sufficient: { kind: "noul", probability: 0.02 },
				semantic_progress: { kind: "score", level: 1, confidence: 0.97 },
				strategy_repetition: { kind: "noul", probability: 0.02 },
				context_stale: { kind: "noul", probability: 0.02 },
				independent_worker_required: { kind: "noul", probability: 0.02 },
				capability_escalation_required: { kind: "noul", probability: 0.02 },
				capability_gap_suspected: { kind: "noul", probability: 0.02 },
				completion_plausible: { kind: "noul", probability: 0.02 },
				step_relevant: { kind: "noul", probability: 0.97 },
				evidence_sufficient_to_act: { kind: "noul", probability: 0.97 },
				unsupported_assumption_present: { kind: "noul", probability: 0.02 },
				route: { kind: "choice", choice: "inspect", confidence: 0.97 },
				action_accomplished_step: { kind: "noul", probability: 0.02 },
				conclusions_supported: { kind: "noul", probability: 0.97 },
				scope_violation: { kind: "noul", probability: 0.02 },
				unrelated_behavior_change: { kind: "noul", probability: 0.02 },
				replan_required: { kind: "noul", probability: 0.02 },
				next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
			});
			world.provider.enqueue("root", text("objective-cycle-root", "Objective cycle reply."));
			const cycle = await withDeadline(
				trace,
				"objective cycle",
				session.continueGoalLoop({ maxStallTurns: 3, maxTurns: 1 }),
				120_000,
			);
			trace.mark("root", "objective-cycle.settled");
			expect(session.executionLoopMode, "the root runs the objective loop").toBe("objective_primary");
			expect(session.systemOneController, "System One is bound to the root").toBeDefined();
			expect(session.objectiveExecutionController, "the objective execution controller is bound").toBeDefined();
			expect(session.getActiveToolNames(), "the root keeps goal and delegate on its foreground surface").toEqual(
				expect.arrayContaining(["goal", "delegate"]),
			);
			const lastRoute = session.objectiveExecutionController?.getLastRoute();
			expect(lastRoute, "System One routed the objective live during the journey").toBeDefined();
			// The route is System One's preflight directive, applied by the controller: its retrieve reason, on the live route.
			expect(lastRoute?.route, "System One's preflight route is applied to the objective").toBe("retrieve");
			expect(lastRoute?.reason_codes).toContain("system_one_preflight_retrieve");
			expect(cycle.stopReason, "the bounded cycle submitted its one root turn").toBe("max_turns_reached");
			expect(cycle.turnsSubmitted).toBe(1);

			// Replay through the public admission API. The same idempotency key admitted twice is one durable message and one
			// worker turn: the second admission returns the first message's id and starts nothing. The persisted mailbox proves it.
			if (blockedAgentId === undefined) throw new Error("the blocked agent id was not recorded");
			const operatorNote = "Operator note: MAX_RETRIES is 5.";
			const replayKey = "operator-note-1";
			const workerTurnsBefore = world.provider.reached.filter((step) => step.startsWith("worker-a:")).length;
			const noteReached = createBarrier();
			const handoffReached = createBarrier();
			world.provider.enqueue("worker-a", {
				name: "replay-note-reply",
				check: () => noteReached.release(),
				reply: { content: [{ type: "text", text: "Noted: MAX_RETRIES is 5." }] },
			});
			world.provider.enqueue("root", {
				name: "replay-handoff-reply",
				check: () => handoffReached.release(),
				reply: { content: [{ type: "text", text: "The worker acknowledged the operator note." }] },
			});
			const firstAdmission = session.backgroundLanes.followUpSessionRootWorkerAgent(blockedAgentId, operatorNote, {
				idempotencyKey: replayKey,
			});
			if (!firstAdmission.started)
				throw new Error(`first admission: ${JSON.stringify({ ...firstAdmission, record: undefined })}`);
			await withDeadline(trace, "worker noted the operator note", noteReached.promise, 60_000);
			await withDeadline(trace, "worker handoff turn", handoffReached.promise, 60_000);
			await withDeadline(trace, "first admission turn settled", session.waitForForegroundIdle(), 60_000);
			const replayAdmission = session.backgroundLanes.followUpSessionRootWorkerAgent(blockedAgentId, operatorNote, {
				idempotencyKey: replayKey,
			});
			expect(replayAdmission.messageId, "a replayed key names the same durable message").toBe(
				firstAdmission.messageId,
			);
			expect(replayAdmission.started, "a replayed key starts no second worker turn").toBe(false);
			await withDeadline(trace, "replay settled", session.waitForForegroundIdle(), 60_000);
			expect(
				world.provider.reached.filter((step) => step.startsWith("worker-a:")).length - workerTurnsBefore,
				"exactly one worker turn ran for the two admissions",
			).toBe(1);
			const replayMailbox = readWorkerMailboxRecord(
				workerMailboxPath(world.agentDir, created.sessionManager.getSessionId(), blockedAgentId),
			).mailbox;
			expect(
				mailboxMessagesOf(replayMailbox).filter((message) => message.messageId === firstAdmission.messageId),
				"one durable message per idempotency key",
			).toHaveLength(1);

			// Verification with a held lane. While a failed run's obligation is open, a held worker waits at its provider gate and a quick
			// worker completes; production refuses completion while the held lane is goal-owned and active, and after both workers are
			// retired the still-open obligation alone refuses it. Each Vitest run checks the file value it reports on: the failing run
			// sees a revision of 4, and the passing recheck follows a real edit back to 5.
			const VITEST_COMMAND = "vitest run test/limits.test.ts";
			const vitestFailed = ["Test Files  1 failed (1)\n", "Tests  1 failed (1)\n"];
			const vitestPassed = ["Test Files  1 passed (1)\n", "Tests  1 passed (1)\n"];
			const limitsIs = (value: number): void => {
				const actual = world.io.readFileSync(LIMITS_PATH, "utf8");
				if (actual !== `export const MAX_RETRIES = ${value};\n`) {
					throw new Error(`the run saw ${JSON.stringify(actual)}, expected MAX_RETRIES = ${value}`);
				}
			};
			world.shell.enqueue(
				{
					name: "vitest-pass-setup",
					command: VITEST_COMMAND,
					output: vitestPassed,
					exitCode: 0,
					check: () => limitsIs(5),
				},
				{
					name: "vitest-fail-revision",
					command: VITEST_COMMAND,
					output: vitestFailed,
					exitCode: 1,
					check: () => limitsIs(4),
				},
				{
					name: "vitest-pass-recheck",
					command: VITEST_COMMAND,
					output: vitestPassed,
					exitCode: 0,
					check: () => limitsIs(5),
				},
			);
			const requirementFrom = (request: ScriptedRequest): string => {
				const goal = latestBatchResults(request).find((result) => result.toolName === "goal");
				const match = /req-[0-9a-f]+/.exec(goal?.text ?? "");
				if (!match) throw new Error(`no requirement id in the goal state: ${goal?.text ?? "no goal result"}`);
				return match[0];
			};
			const refusedGoal = (request: ScriptedRequest, label: string, diagnostic: string): void => {
				const refused = latestBatchResults(request).find((result) => result.toolName === "goal");
				if (!refused?.isError || !refused.text.includes(diagnostic)) {
					throw new Error(
						`${label}: expected a refusal naming "${diagnostic}", got ${refused?.text ?? "no goal result"}`,
					);
				}
			};
			const verifyJudgments = {
				changes_model_pools: { kind: "noul", probability: 0.02 },
				local_commits_only: { kind: "noul", probability: 0.02 },
				lifts_delivery_block: { kind: "noul", probability: 0.02 },
				full_handoff: { kind: "noul", probability: 0.02 },
				optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
				step_relevant: { kind: "noul", probability: 0.97 },
				evidence_sufficient_to_act: { kind: "noul", probability: 0.97 },
				unsupported_assumption_present: { kind: "noul", probability: 0.02 },
				route: { kind: "choice", choice: "inspect", confidence: 0.97 },
				action_accomplished_step: { kind: "noul", probability: 0.02 },
				conclusions_supported: { kind: "noul", probability: 0.97 },
				scope_violation: { kind: "noul", probability: 0.02 },
				unrelated_behavior_change: { kind: "noul", probability: 0.02 },
				replan_required: { kind: "noul", probability: 0.02 },
				next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
				capabilities_authorized: { kind: "noul", probability: 0.02 },
			} as const;
			const operationClasses = {
				leaves_machine: { kind: "noul", probability: 0.02 },
				cannot_be_undone: { kind: "noul", probability: 0.02 },
				touches_outside_task: { kind: "noul", probability: 0.02 },
				acquires_external_code: { kind: "noul", probability: 0.02 },
				request_authorizes: { kind: "noul", probability: 0.02 },
			} as const;
			const completionStates = {
				states_tests_pass: { kind: "choice", choice: "no_current_success", confidence: 0.97 },
				states_committed: { kind: "noul", probability: 0.02 },
				states_pushed: { kind: "noul", probability: 0.02 },
				states_published: { kind: "noul", probability: 0.02 },
				states_files_changed: { kind: "noul", probability: 0.97 },
			} as const;
			const completionJudgments = {
				outcomes_achieved: { kind: "noul", probability: 0.97 },
				required_behavior_unverified: { kind: "noul", probability: 0.02 },
				material_claim_unsupported: { kind: "noul", probability: 0.02 },
				missing_requirement: { kind: "noul", probability: 0.02 },
			} as const;
			const quickHandedOff = createBarrier();
			const heldHandedOff = createBarrier();
			const heldMayRead = createBarrier();
			// The held worker waits at its first request until the root releases it; the quick worker completes at once.
			world.provider.enqueue(
				"worker-b",
				{
					name: "held-read",
					gate: heldMayRead.promise,
					reply: {
						content: [{ type: "toolCall", id: "held-read-1", name: "read", arguments: { path: LIMITS_PATH } }],
						stopReason: "toolUse",
					},
				},
				calls("held-report", [
					{
						id: "held-report-1",
						name: "submit_report",
						arguments: { status: "completed", summary: "The held value is read." },
					},
				]),
			);
			world.provider.enqueue(
				"worker-c",
				calls("quick-read", [{ id: "quick-read-1", name: "read", arguments: { path: LIMITS_PATH } }]),
				calls("quick-report", [
					{
						id: "quick-report-1",
						name: "submit_report",
						arguments: { status: "completed", summary: "The quick value is read." },
					},
				]),
			);
			// Setup: the limit is set to 5 and the passing run becomes evidence for the requirement.
			world.systemOne.enterPhase("verify-setup", {
				...verifyJudgments,
				...operationClasses,
				...completionStates,
				// The setup answer reports the passing run as recorded evidence: a current-work success claim.
				states_tests_pass: { kind: "choice", choice: "current_success", confidence: 0.97 },
			});
			world.provider.enqueue(
				"root",
				calls("edit-to-five", [
					{
						id: "edit-five-1",
						name: "edit",
						arguments: { path: LIMITS_PATH, edits: [{ oldText: "MAX_RETRIES = 3", newText: "MAX_RETRIES = 5" }] },
					},
				]),
				calls("vitest-pass", [{ id: "verify-pass-1", name: "bash", arguments: { command: VITEST_COMMAND } }]),
				calls("goal-get", [{ id: "goal-get-1", name: "goal", arguments: { action: "get" } }]),
				dynamicCalls(
					"add-evidence",
					(request) => [
						{
							id: "evidence-1",
							name: "goal",
							arguments: {
								action: "add_evidence",
								kind: "test",
								uri: "verify-pass-1",
								summary: "vitest passed: MAX_RETRIES is 5",
								requirementIds: [requirementFrom(request)],
							},
						},
					],
					(request) => assertBatchOk(request, "goal-get"),
				),
				text("evidence-recorded", "The passing run is recorded as evidence."),
			);
			await withDeadline(
				trace,
				"verification setup",
				session.prompt("Set the limit to 5 and record the passing run."),
			);
			trace.mark("root", "verification.setup");
			// Revision: the limit is changed to 4, the test fails, and two workers start: one held, one quick.
			world.systemOne.enterPhase("verify-revision", { ...verifyJudgments, ...completionStates });
			world.provider.enqueue(
				"root",
				calls("edit-to-four", [
					{
						id: "edit-four-1",
						name: "edit",
						arguments: { path: LIMITS_PATH, edits: [{ oldText: "MAX_RETRIES = 5", newText: "MAX_RETRIES = 4" }] },
					},
				]),
				calls("vitest-fail", [{ id: "verify-fail-1", name: "bash", arguments: { command: VITEST_COMMAND } }]),
				calls("start-held", [
					{
						id: "start-held-1",
						name: "delegate",
						arguments: {
							action: "start",
							model: { provider: "harness-script", modelId: "worker-b" },
							instructions: "Read src/limits.ts and report its value once the owner releases you.",
						},
					},
				]),
				calls("start-quick", [
					{
						id: "start-quick-1",
						name: "delegate",
						arguments: {
							action: "start",
							model: { provider: "harness-script", modelId: "worker-c" },
							instructions: "Read src/limits.ts and report its value.",
						},
					},
				]),
				text("revision-started", "The revision failed its test; two checks are running."),
			);
			world.provider.enqueue(
				"root",
				// The quick worker's terminal handoff starts this root turn while the held worker still waits at its gate.
				{
					name: "quick-handoff",
					check: (request) => {
						if (!JSON.stringify(request.context.messages).includes("The quick value is read.")) {
							throw new Error("the quick worker's handoff is not in the root turn");
						}
						quickHandedOff.release();
					},
					reply: {
						content: [{ type: "text", text: "The quick check is reported; the held check is still running." }],
					},
				},
			);
			await withDeadline(
				trace,
				"revision turn",
				session.prompt("Revise the limit to 4, run the test, and start the checks."),
			);
			trace.mark("root", "verification.revised");
			await withDeadline(trace, "quick worker handed off", quickHandedOff.promise, 90_000);
			await withDeadline(trace, "quick handoff turn settled", session.waitForForegroundIdle(), 90_000);
			// The other lane completed; the held lane is still running, so completion is refused by the goal-owned lane.
			world.systemOne.enterPhase("verify-refused", { ...verifyJudgments, ...completionStates });
			world.provider.enqueue(
				"root",
				calls("complete-refused", [{ id: "complete-1", name: "goal", arguments: { action: "complete" } }]),
				{
					name: "refusal-reported",
					check: (request) => {
						refusedGoal(
							request,
							"completion while the held lane runs",
							"goal-owned worker lane(s) are still active",
						);
					},
					reply: { content: [{ type: "text", text: "Completion waits for the held check." }] },
				},
			);
			await withDeadline(trace, "refused completion", session.prompt("Check whether the goal can complete now."));
			trace.mark("root", "completion.refused");
			if (world.provider.reached.includes("worker-b:held-report")) {
				throw new Error("the held worker reported before the owner released it");
			}
			// The held lane is released: it reads, reports, and its handoff starts a root turn.
			world.systemOne.enterPhase("verify-held", completionStates);
			world.provider.enqueue("root", {
				name: "held-handoff",
				check: (request) => {
					if (!JSON.stringify(request.context.messages).includes("The held value is read.")) {
						throw new Error("the held worker's handoff is not in the root turn");
					}
					heldHandedOff.release();
				},
				reply: { content: [{ type: "text", text: "Both checks are reported." }] },
			});
			heldMayRead.release();
			await withDeadline(trace, "held worker handed off", heldHandedOff.promise, 90_000);
			await withDeadline(trace, "held handoff turn settled", session.waitForForegroundIdle(), 90_000);
			// Both workers are retired, then the open obligation alone refuses completion.
			world.systemOne.enterPhase("verify-obligation", verifyJudgments);
			world.provider.enqueue(
				"root",
				dynamicCalls("retire-workers", (request) => [
					{
						id: "retire-held-1",
						name: "delegate",
						arguments: { action: "retire", agentId: latestAgentIdForTrack(request, "worker-b") },
					},
					{
						id: "retire-quick-1",
						name: "delegate",
						arguments: { action: "retire", agentId: latestAgentIdForTrack(request, "worker-c") },
					},
				]),
				{
					name: "retirements-recorded",
					check: (request) => {
						const retirements = latestBatchResults(request).filter((result) => result.toolName === "delegate");
						if (
							retirements.length !== 2 ||
							retirements.some((result) => result.isError || !result.text.includes("retired"))
						)
							throw new Error(
								`the held and quick workers were not both retired: ${JSON.stringify(retirements)}`,
							);
					},
					reply: {
						content: [{ type: "toolCall", id: "complete-3", name: "goal", arguments: { action: "complete" } }],
						stopReason: "toolUse",
					},
				},
				{
					name: "obligation-reported",
					check: (request) => {
						refusedGoal(
							request,
							"completion after the held lane completed",
							"active verification obligation(s) remain",
						);
					},
					reply: { content: [{ type: "text", text: "The obligation is still open." }] },
				},
			);
			await withDeadline(
				trace,
				"retirement and obligation refusal",
				session.prompt("Retire the checks and check completion again."),
			);
			trace.mark("root", "obligation.still-open");
			// Revision after the failure: a real edit back to 5, a passing recheck, and host-gated completion.
			world.systemOne.enterPhase("verify-recheck", {
				...verifyJudgments,
				...completionJudgments,
			});
			world.provider.enqueue(
				"root",
				calls("edit-back-to-five", [
					{
						id: "edit-five-2",
						name: "edit",
						arguments: { path: LIMITS_PATH, edits: [{ oldText: "MAX_RETRIES = 4", newText: "MAX_RETRIES = 5" }] },
					},
				]),
				calls("vitest-recheck", [{ id: "verify-pass-2", name: "bash", arguments: { command: VITEST_COMMAND } }]),
				calls("complete-final", [{ id: "complete-2", name: "goal", arguments: { action: "complete" } }]),
				{
					name: "completed",
					check: (request) => {
						assertBatchOk(request, "complete-final");
						if (!latestBatchResults(request).some((result) => result.text.includes("goal complete recorded"))) {
							throw new Error("the goal was not completed after the passing recheck cleared the obligation");
						}
					},
					reply: { content: [{ type: "text", text: "The goal is complete." }] },
				},
			);
			await withDeadline(
				trace,
				"recheck and completion",
				session.prompt("Make the revision back to 5, recheck, and complete the goal."),
			);
			trace.mark("root", "goal.completed");
			expect(session.getGoalStateSnapshot()?.status, "the host records the goal as completed").toBe("completed");
			expect(
				getLatestGoalStateSnapshot(created.sessionManager)?.status,
				"the persisted goal snapshot agrees with the host",
			).toBe("completed");
			expect(
				receiptsOf(replayMailbox).filter(
					(receipt) => receipt.messageId === firstAdmission.messageId && receipt.kind === "control",
				),
				"one durable control receipt per idempotency key",
			).toHaveLength(1);
		},
	);
}, 180_000);

/** Tool results the production loop recorded after the latest assistant turn: the outcomes this step answers. */
/**
 * The lanes a `worktree_sync` status reports: lane key and checkout path, plus the bound agent when one is bound; the credential guard keeps the `laneKey` key readable and retains independent secret-value redaction.
 */
function lanesOf(
	details: unknown,
): Array<{ readonly laneKey: string; readonly worktreePath: string; readonly boundLaneId?: string }> {
	if (typeof details !== "object" || details === null || !("lanes" in details) || !Array.isArray(details.lanes)) {
		throw new Error("the status details carry no lanes");
	}
	return details.lanes.map((lane: unknown) => {
		if (
			typeof lane !== "object" ||
			lane === null ||
			!("laneKey" in lane) ||
			typeof lane.laneKey !== "string" ||
			!("worktreePath" in lane) ||
			typeof lane.worktreePath !== "string"
		) {
			throw new Error("a status lane carries no laneKey or worktreePath");
		}
		const bound = "boundLaneId" in lane && typeof lane.boundLaneId === "string" ? lane.boundLaneId : undefined;
		return bound === undefined
			? { laneKey: lane.laneKey, worktreePath: lane.worktreePath }
			: { laneKey: lane.laneKey, worktreePath: lane.worktreePath, boundLaneId: bound };
	});
}

/** Evidence ids the host reported in goal results, in the order the transcript shows them. */
function evidenceIdsOf(request: ScriptedRequest): string[] {
	const ids: string[] = [];
	for (const message of request.context.messages) {
		if (message.role !== "toolResult" || message.toolName !== "goal") continue;
		for (const match of JSON.stringify(message.content).matchAll(/ev-[0-9a-f]+/g)) {
			if (!ids.includes(match[0])) ids.push(match[0]);
		}
	}
	if (ids.length === 0) throw new Error("no evidence id in any goal result of the transcript");
	return ids;
}

/** The requirement id in the most recent goal result of the transcript, however many turns back it is. */
function requirementIdOf(request: ScriptedRequest): string {
	const messages = request.context.messages;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "toolResult" || message.toolName !== "goal") continue;
		const text = JSON.stringify(message.content);
		const match = /req-[0-9a-f]+/.exec(text);
		if (match) return match[0];
	}
	throw new Error("no requirement id in any goal result of the transcript");
}

/** The marker of the root reflection checkpoint: the reflection turn's own prompt, which the production loop sends after a unit of work. */
const REFLECTION_CHECKPOINT_MARKER = "Reflection checkpoint: the unit of work above has ended.";

/** True when a request-visible message carries the marker text. */
function requestCarriesMarker(request: ScriptedRequest, marker: string): boolean {
	return request.context.messages.some((message) => JSON.stringify(message).includes(marker));
}

/**
 * A submit_report result whose host receipt matches its call: the same call id, and a completed, successful invocation. Tool
 * receipt, not host acceptance: it proves the host recorded the call, nothing about the claim's verdict.
 */
function matchedSubmitReceipt(request: ScriptedRequest, callId: string): boolean {
	return request.context.messages.some((message) => {
		if (message.role !== "toolResult" || message.toolName !== "submit_report" || message.toolCallId !== callId)
			return false;
		const details: unknown = message.details;
		if (typeof details !== "object" || details === null || !("piToolInvocation" in details)) return false;
		const invocation: unknown = details.piToolInvocation;
		return (
			typeof invocation === "object" &&
			invocation !== null &&
			"execution" in invocation &&
			invocation.execution === "completed" &&
			"operationStatus" in invocation &&
			invocation.operationStatus === "success"
		);
	});
}

/**
 * True when the current host request carries the text: the messages after the latest assistant turn, not the whole history. An older
 * request's text cannot satisfy a fresh request's check.
 */
function currentRequestCarries(request: ScriptedRequest, text: string): boolean {
	const messages = request.context.messages;
	let start = messages.length;
	while (start > 0 && messages[start - 1]?.role !== "assistant") start--;
	return JSON.stringify(messages.slice(start)).includes(text);
}

/** The task id the latest bash start carried in its tool result details. */
function backgroundTaskIdOf(request: ScriptedRequest): string {
	const messages = request.context.messages;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "toolResult" || message.toolName !== "bash") continue;
		const details: unknown = message.details;
		if (
			typeof details === "object" &&
			details !== null &&
			"taskId" in details &&
			typeof details.taskId === "string"
		) {
			return details.taskId;
		}
		throw new Error("the latest bash result carries no background task id");
	}
	throw new Error("no bash result is in the request");
}

/** True when one message of the request is the background handoff that names this task id. */
function handoffFor(request: ScriptedRequest, taskId: string): boolean {
	return request.context.messages.some((message) => {
		const text = JSON.stringify(message);
		return text.includes("Background tool terminal handoff") && text.includes(taskId);
	});
}

/** The command of a bash tool call's validated arguments, or undefined when the arguments carry none. */
function commandOf(args: unknown): unknown {
	return typeof args === "object" && args !== null && "command" in args ? args.command : undefined;
}

function latestBatchResults(request: ScriptedRequest): Array<{ toolName: string; isError: boolean; text: string }> {
	const messages = request.context.messages;
	let start = messages.length;
	while (start > 0 && messages[start - 1]?.role !== "assistant") start--;
	const results: Array<{ toolName: string; isError: boolean; text: string }> = [];
	for (const message of messages.slice(start)) {
		if (message.role !== "toolResult") continue;
		const text = message.content.map((block) => (block.type === "text" ? block.text : block.type)).join("\n");
		results.push({ toolName: message.toolName, isError: message.isError, text });
	}
	return results;
}

/** Fails the step with the failing production result, so the journey stops at the call that broke. */
function assertBatchOk(request: ScriptedRequest, label: string): void {
	for (const result of latestBatchResults(request)) {
		if (result.isError) throw new Error(`${label}: ${result.toolName} failed: ${result.text.slice(0, 600)}`);
	}
}

/**
 * The absolute path a request-visible `PATH ALIASES` legend line names. The model reads its legend from the request it is
 * sent, so the positive path oracle is that legend, never the raw transcript.
 */
function requestTexts(request: ScriptedRequest): string[] {
	return request.context.messages.flatMap((message) =>
		typeof message.content === "string"
			? [message.content]
			: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
	);
}

/** The persisted alias rows of one session store, read through a read-only connection that is closed before returning. */
function readPathAliases(path: string): Array<{ full_path: string; alias_id: string }> {
	const sqlite = process.getBuiltinModule("node:sqlite");
	if (sqlite === undefined) throw new Error("node:sqlite is unavailable");
	const database = new sqlite.DatabaseSync(path, { readOnly: true });
	try {
		return database.prepare("SELECT full_path, alias_id FROM path_aliases").all() as Array<{
			full_path: string;
			alias_id: string;
		}>;
	} finally {
		database.close();
	}
}

/** The messages of a persisted worker mailbox record, validated structurally before they are read. */
function mailboxMessagesOf(mailbox: unknown): Array<{ messageId: string; content: string; deliveredAt?: string }> {
	if (
		typeof mailbox !== "object" ||
		mailbox === null ||
		!("messages" in mailbox) ||
		!Array.isArray(mailbox.messages)
	) {
		throw new Error("the mailbox record carries no messages");
	}
	return mailbox.messages.map((message: unknown) => {
		if (typeof message !== "object" || message === null || !("messageId" in message) || !("content" in message)) {
			throw new Error("a mailbox message is malformed");
		}
		const deliveredAt =
			"deliveredAt" in message && typeof message.deliveredAt === "string" ? message.deliveredAt : undefined;
		return {
			messageId: String(message.messageId),
			content: String(message.content),
			...(deliveredAt === undefined ? {} : { deliveredAt }),
		};
	});
}

/** The receipts of a persisted worker mailbox record, validated structurally before they are read. */
function receiptsOf(mailbox: unknown): Array<{ kind: string; messageId: string }> {
	if (
		typeof mailbox !== "object" ||
		mailbox === null ||
		!("replayReceipts" in mailbox) ||
		!Array.isArray(mailbox.replayReceipts)
	) {
		throw new Error("the mailbox record carries no replay receipts");
	}
	return mailbox.replayReceipts.map((receipt: unknown) => {
		if (typeof receipt !== "object" || receipt === null || !("kind" in receipt) || !("messageId" in receipt)) {
			throw new Error("a replay receipt is malformed");
		}
		return { kind: String(receipt.kind), messageId: String(receipt.messageId) };
	});
}

/** Every `p/<id>=<absolute path>` line the request-visible legend carries, in order. */
function legendLinesOf(request: ScriptedRequest): string[] {
	return requestTexts(request)
		.flatMap((text) => text.split("\n"))
		.filter((line) => /^p\/\S+=\S+$/.test(line));
}

/** The alias the request-visible legend assigns to an absolute path, when the legend carries it. */
function legendAliasFor(request: ScriptedRequest, absolutePath: string): string | undefined {
	const display = absolutePath.startsWith(`${HARNESS_PROJECT_CWD}/`)
		? absolutePath.slice(HARNESS_PROJECT_CWD.length + 1)
		: absolutePath;
	for (const text of requestTexts(request)) {
		for (const line of text.split("\n")) {
			const match = /^(p\/\S+)=(\S+)$/.exec(line);
			if (
				match?.[1] &&
				(match[2] === absolutePath ||
					match[2] === display ||
					resolve(HARNESS_PROJECT_CWD, match[2]) === absolutePath)
			) {
				return match[1];
			}
		}
	}
	return undefined;
}

/** The text of a utf8 read: a non-text read is a broken oracle, so it fails instead of being coerced. */
function utf8Text(content: string | Buffer): string {
	if (typeof content !== "string") throw new TypeError("a utf8 read returned bytes");
	return content;
}

function legendPath(request: ScriptedRequest, alias: string): string {
	const pattern = new RegExp(`^${alias}=(\\S+)$`, "m");
	for (const text of requestTexts(request)) {
		const match = pattern.exec(text);
		if (match?.[1]) return resolve(HARNESS_PROJECT_CWD, match[1]);
	}
	throw new Error(`${alias} is not in the request-visible PATH ALIASES legend`);
}

/** The conflict block a read of the conflicted file shows, exactly as the request carries it. */
function conflictBlockIn(request: ScriptedRequest): string {
	const read = latestBatchResults(request).find((result) => result.toolName === "read");
	const match = /<<<<<<< HEAD[\s\S]*?>>>>>>> [^\n]*/.exec(read?.text ?? "");
	if (!match) throw new Error(`no conflict block in the read result: ${read?.text ?? "no read"}`);
	return match[0];
}

/** The latest batch must hold a refused call whose text names the diagnostic. */
function assertRefused(request: ScriptedRequest, label: string, diagnostic: string): void {
	const results = latestBatchResults(request);
	if (!results.some((result) => result.isError && result.text.includes(diagnostic))) {
		throw new Error(`${label}: expected a refusal naming "${diagnostic}", got ${JSON.stringify(results)}`);
	}
}

/** The structured details of the newest `worktree_sync` result in the transcript (not text-matched). */
/** The structured details of the newest result of `toolName` in the transcript (not text-matched). */
function lastToolResultDetails(session: AgentSession, toolName: string): unknown {
	for (let index = session.messages.length - 1; index >= 0; index--) {
		const message = session.messages[index];
		if (message?.role === "toolResult" && message.toolName === toolName) return message.details;
	}
	return undefined;
}

function isStaleRefusal(details: unknown): boolean {
	return (
		typeof details === "object" &&
		details !== null &&
		"code" in details &&
		(details.code === "stale_lane" || details.code === "sync_required")
	);
}

function isGateCommandRefusal(details: unknown): boolean {
	return typeof details === "object" && details !== null && "code" in details && details.code === "gate_command_unset";
}

/** A step whose tool calls depend on what production reported earlier. */
function dynamicCalls(
	name: string,
	plan: (request: ScriptedRequest) => Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
	check?: (request: ScriptedRequest) => void,
): ScriptStep {
	return {
		name,
		check,
		reply: (request) => ({
			content: plan(request).map((call) => ({ type: "toolCall" as const, ...call })),
			stopReason: "toolUse",
		}),
	};
}

const ORIGINAL_LIMITS = "export const MAX_RETRIES = 3;\n";
const OWNER_DRAFT_V1 = "owner draft v1\n";
const NOTES_V1 = "stage one\n";
const OWNER_DRAFT_DIRTY = "owner draft v2 (unstaged, not mine)\n";

it("mixed: a root lane and a worker lane in separate worktrees, a real conflict, explicit resolution, integration, owner edits kept", async () => {
	await runJourney(
		{
			name: "journey-3",
			// worktree_sync is opt-in: the owner's default-tools setting names it alongside the default surface. The owner's draft is
			// dirty from the start, so lanes are created explicitly and the worker is started on its request-visible lane checkout.
			settings: { defaultTools: [...DEFAULT_ACTIVE_TOOL_NAMES, "worktree_sync"] },
			files: {
				[`${HARNESS_PROJECT_CWD}/src/limits.ts`]: ORIGINAL_LIMITS,
				[`${HARNESS_PROJECT_CWD}/src/owner.md`]: OWNER_DRAFT_DIRTY,
				[`${HARNESS_PROJECT_CWD}/src/notes.md`]: NOTES_V1,
			},
			repository: {
				committed: { "src/limits.ts": ORIGINAL_LIMITS, "src/owner.md": OWNER_DRAFT_V1, "src/notes.md": NOTES_V1 },
				dirty: { "src/owner.md": OWNER_DRAFT_DIRTY },
			},
		},
		async (world) => {
			const trace = world.trace;
			const integrated = createBarrier();
			const workerMayEdit = createBarrier();
			const handedOff = createBarrier();
			let rootSession: AgentSession | undefined;
			let workerLaneKey: string | undefined;
			let mainBeforeRefusal: string | undefined;
			let mainBeforeStale: string | undefined;
			let mainAfterLand: string | undefined;
			let legendAtIntegration: string[] = [];
			const sessionOf = (): AgentSession => {
				if (rootSession === undefined) throw new Error("the root session is not created yet");
				return rootSession;
			};
			const laneKeyOrThrow = (): string => {
				if (workerLaneKey === undefined)
					throw new Error("the worker lane key was not read from the status details");
				return workerLaneKey;
			};
			const checkoutHandoffs = (request: ScriptedRequest): void => {
				if (!JSON.stringify(request.context.messages).includes("Background worker terminal handoff")) {
					throw new Error("the worker's terminal handoff is not in the root turn");
				}
			};
			// The worker: held at its first request until the root has committed its own lane; then edits its lane and reports.
			world.provider.enqueue(
				"worker-a",
				{
					name: "worker-edit",
					gate: workerMayEdit.promise,
					reply: {
						content: [
							{
								type: "toolCall",
								id: "worker-edit-1",
								name: "edit",
								arguments: {
									path: "src/limits.ts",
									edits: [{ oldText: "MAX_RETRIES = 3", newText: "MAX_RETRIES = 5" }],
								},
							},
						],
						stopReason: "toolUse",
					},
				},
				calls("worker-report", [
					{
						id: "worker-report-1",
						name: "submit_report",
						arguments: {
							status: "completed",
							summary: "Set MAX_RETRIES to 5 in my lane.",
							changes: [{ file: "src/limits.ts", what: "Raises MAX_RETRIES to 5 in the retries lane." }],
						},
					},
				]),
			);
			// Prompt one: the root creates its two lanes, starts the worker on the request-visible retries checkout, reads the lane
			// identities from the structured status, and works its own lane while the worker is held at its first request.
			world.provider.enqueue(
				"root",
				calls("goal-start", [
					{
						id: "goal-1",
						name: "goal",
						arguments: {
							action: "start",
							goalId: "retries-goal",
							userGoal: "Set MAX_RETRIES to 5 and keep the owner's draft.",
						},
					},
				]),
				calls("create-rootwork-lane", [
					{
						id: "lane-rootwork",
						name: "worktree_sync",
						arguments: { action: "create_lane", laneKey: "rootwork", goalId: "retries-goal" },
					},
				]),
				calls("create-retries-lane", [
					{
						id: "lane-retries",
						name: "worktree_sync",
						arguments: { action: "create_lane", laneKey: "retries", goalId: "retries-goal" },
					},
				]),
				dynamicCalls(
					"start-worker",
					(request) => {
						const retries = legendPath(request, "p/retries");
						return [
							{
								id: "start-worker-1",
								name: "delegate",
								arguments: {
									action: "start",
									model: { provider: "harness-script", modelId: "worker-a" },
									path: retries,
									writePaths: [`${retries}/src/limits.ts`],
									instructions:
										"Set MAX_RETRIES to 5 in src/limits.ts of your checkout, then submit your report.",
								},
							},
						];
					},
					(request) => assertBatchOk(request, "create-retries-lane"),
				),
				{
					name: "status-admitted",
					check: (request) => {
						assertBatchOk(request, "start-worker");
						if (
							!latestBatchResults(request).some((result) => result.text.includes("delegate started (running)"))
						) {
							throw new Error("the worker was not admitted");
						}
					},
					reply: {
						content: [
							{ type: "toolCall", id: "status-1", name: "worktree_sync", arguments: { action: "status" } },
						],
						stopReason: "toolUse",
					},
				},
				{
					name: "identities-checked",
					check: (request) => {
						assertBatchOk(request, "status-admitted");
						const details = lastToolResultDetails(sessionOf(), "worktree_sync");
						// Structured output round-trips: no credential placeholder replaces a lane key or path.
						if (JSON.stringify(details).includes("<mocked:")) {
							throw new Error(`the status details carry a redacted field: ${JSON.stringify(details)}`);
						}
						const lanes = lanesOf(details);
						const agent = agentIdForTrack(request, "worker-a");
						const retries = legendPath(request, "p/retries");
						const bound = lanes.filter((lane) => lane.boundLaneId !== undefined);
						const root = lanes.filter((lane) => lane.boundLaneId === undefined);
						if (lanes.length !== 2 || bound.length !== 1 || bound[0]?.boundLaneId !== agent) {
							throw new Error(`worker and root lanes are not separate: ${JSON.stringify(lanes)} agent ${agent}`);
						}
						if (bound[0]?.laneKey !== "retries" || bound[0]?.worktreePath !== retries) {
							throw new Error(`the worker is not bound to its requested checkout: ${JSON.stringify(bound)}`);
						}
						if (root[0]?.laneKey !== "rootwork")
							throw new Error(`the root lane is not rootwork: ${JSON.stringify(root)}`);
						// The lane key is read back from the structured output, and later steps use that value.
						workerLaneKey = bound[0].laneKey;
					},
					reply: {
						content: [
							{
								type: "toolCall",
								id: "alias-negative-1",
								name: "edit",
								arguments: {
									path: "p/rootwork/src/limits.ts",
									edits: [{ oldText: "MAX_RETRIES = 3", newText: "MAX_RETRIES = 4" }],
								},
							},
						],
						stopReason: "toolUse",
					},
				},
				dynamicCalls(
					"edit-rootwork",
					(request) => [
						{
							id: "edit-rootwork-1",
							name: "edit",
							arguments: {
								path: `${legendPath(request, "p/rootwork")}/src/limits.ts`,
								edits: [{ oldText: "MAX_RETRIES = 3", newText: "MAX_RETRIES = 4" }],
							},
						},
					],
					(request) => assertRefused(request, "the extrapolated alias", "Unminted path alias"),
				),
				calls("commit-rootwork", [
					{
						id: "add-rootwork",
						name: "worktree_sync",
						arguments: { action: "git_add", laneKey: "rootwork", paths: ["src/limits.ts"] },
					},
					{
						id: "commit-rootwork",
						name: "worktree_sync",
						arguments: { action: "git_commit", laneKey: "rootwork", message: "Raise MAX_RETRIES to 4" },
					},
				]),
				{
					name: "rootwork-committed",
					check: (request) => {
						assertBatchOk(request, "commit-rootwork");
						// The worker is released only now: its lane edit overlaps the root's committed lane work.
						workerMayEdit.release();
					},
					reply: {
						content: [{ type: "text", text: "Rootwork is committed; the worker is still working in its lane." }],
					},
				},
			);
			// The worker's terminal handoff starts a root turn: the worker's lane is committed, its first land is refused by the
			// gate, the gate is opened explicitly, and the lane lands at epoch 1; the stale rootwork land is then refused.
			world.provider.enqueue(
				"root",
				dynamicCalls(
					"handoff-received",
					() => [
						{
							id: "add-worker-1",
							name: "worktree_sync",
							arguments: { action: "git_add", laneKey: laneKeyOrThrow(), paths: ["src/limits.ts"] },
						},
						{
							id: "commit-worker-1",
							name: "worktree_sync",
							arguments: { action: "git_commit", laneKey: laneKeyOrThrow(), message: "Set MAX_RETRIES to 5" },
						},
					],
					(request) => {
						checkoutHandoffs(request);
						handedOff.release();
					},
				),
				dynamicCalls(
					"land-worker-refused",
					() => [
						{
							id: "land-worker-1",
							name: "worktree_sync",
							arguments: { action: "land", laneKey: laneKeyOrThrow() },
						},
					],
					(request) => {
						assertBatchOk(request, "handoff-received");
						mainBeforeRefusal = world.git.refSha("refs/heads/main");
					},
				),
				dynamicCalls(
					"land-worker-positive",
					() => [
						{
							id: "land-worker-2",
							name: "worktree_sync",
							arguments: { action: "land", laneKey: laneKeyOrThrow() },
						},
					],
					(request) => {
						assertBatchOk(request, "land-worker-refused");
						if (!isGateCommandRefusal(lastToolResultDetails(sessionOf(), "worktree_sync"))) {
							throw new Error("the worker lane's first land was not refused by the gate");
						}
						if (world.git.refSha("refs/heads/main") !== mainBeforeRefusal)
							throw new Error("a refused land moved main");
						// The owner-level opt-out, recorded per land event, then the positive land runs with the gate off.
						world.settingsManager.applyOverrides({ worktreeSync: { gate: "off" } });
					},
				),
				{
					name: "worker-landed",
					check: (request) => {
						const landed = latestBatchResults(request).find((result) => result.text.includes("LANDED"));
						if (!landed?.text.includes("LANDED: epoch 1")) {
							throw new Error(`the worker lane did not land at epoch 1: ${landed?.text ?? "no land"}`);
						}
						mainBeforeStale = world.git.refSha("refs/heads/main");
					},
					reply: {
						content: [
							{
								type: "toolCall",
								id: "land-rootwork-stale",
								name: "worktree_sync",
								arguments: { action: "land", laneKey: "rootwork" },
							},
						],
						stopReason: "toolUse",
					},
				},
				{
					name: "stale-refused",
					check: (request) => {
						assertBatchOk(request, "land-rootwork-stale");
						if (!isStaleRefusal(lastToolResultDetails(sessionOf(), "worktree_sync"))) {
							throw new Error(
								`the rootwork land was not refused as stale: ${JSON.stringify(lastToolResultDetails(sessionOf(), "worktree_sync"))}`,
							);
						}
						if (world.git.refSha("refs/heads/main") !== mainBeforeStale)
							throw new Error("a refused stale land moved main");
					},
					reply: {
						content: [{ type: "text", text: "The worker lane landed; the rootwork lane is behind main." }],
					},
				},
			);
			// Resolution turn: the rootwork lane syncs against the landed worker lane, the conflict is read and resolved through the
			// request-visible legend path, then the lane lands and the worker's landing is replayed.
			world.provider.enqueue(
				"root",
				calls("sync-rootwork", [
					{ id: "sync-rootwork-1", name: "worktree_sync", arguments: { action: "sync", laneKey: "rootwork" } },
				]),
				dynamicCalls(
					"read-conflict",
					(request) => [
						{
							id: "read-conflict-1",
							name: "read",
							arguments: { path: `${legendPath(request, "p/rootwork")}/src/limits.ts` },
						},
					],
					(request) => {
						const sync = latestBatchResults(request).find((result) => result.toolName === "worktree_sync");
						if (!sync?.text.toLowerCase().includes("conflict")) {
							throw new Error(`sync did not report a conflict: ${sync?.text ?? "no sync result"}`);
						}
					},
				),
				dynamicCalls(
					"resolve-conflict",
					(request) => [
						{
							id: "resolve-conflict-1",
							name: "edit",
							arguments: {
								path: `${legendPath(request, "p/rootwork")}/src/limits.ts`,
								edits: [{ oldText: conflictBlockIn(request), newText: "export const MAX_RETRIES = 5;" }],
							},
						},
					],
					(request) => {
						const read = latestBatchResults(request).find((result) => result.toolName === "read");
						if (!read?.text.includes("<<<<<<< HEAD"))
							throw new Error(`the conflicted file was not shown: ${read?.text ?? "no read"}`);
					},
				),
				calls("continue-rootwork", [
					{
						id: "continue-rootwork-1",
						name: "worktree_sync",
						arguments: { action: "continue", laneKey: "rootwork" },
					},
				]),
				calls("land-rootwork", [
					{ id: "land-rootwork-1", name: "worktree_sync", arguments: { action: "land", laneKey: "rootwork" } },
				]),
				dynamicCalls(
					"replay-worker-landing",
					() => [
						{
							id: "replay-worker-1",
							name: "worktree_sync",
							arguments: { action: "land", laneKey: laneKeyOrThrow() },
						},
					],
					(request) => {
						assertBatchOk(request, "land-rootwork");
						const landed = latestBatchResults(request).find((result) => result.text.includes("LANDED"));
						if (!landed?.text.includes("LANDED: epoch 2")) {
							throw new Error(
								`rootwork did not land at epoch 2: ${landed?.text ?? "no land"}\n${toolOutcomes(sessionOf())}`,
							);
						}
						mainAfterLand = world.git.refSha("refs/heads/main");
					},
				),
				{
					name: "integrated",
					check: (request) => {
						const replayed = latestBatchResults(request).find((result) => result.toolName === "worktree_sync");
						if (replayed?.text.includes("LANDED"))
							throw new Error(`a replayed land landed again: ${replayed.text}`);
						if (world.git.refSha("refs/heads/main") !== mainAfterLand)
							throw new Error("a replayed land moved main");
						legendAtIntegration = legendLinesOf(request);
						integrated.release();
					},
					reply: {
						content: [
							{
								type: "text",
								text: "Both lanes are integrated; MAX_RETRIES is 5 and the owner's draft is untouched.",
							},
						],
					},
				},
			);

			const created = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
			const session = created.session;
			rootSession = session;
			trace.mark("root", "session.created");
			// Judgments per turn: the setup turn asks the completion state claims and two read-output claims; the resolution turn
			// asks the steering family. Each phase declares exactly what its turns ask.
			const setupJudgments = {
				changes_model_pools: { kind: "noul", probability: 0.02 },
				local_commits_only: { kind: "noul", probability: 0.02 },
				lifts_delivery_block: { kind: "noul", probability: 0.02 },
				full_handoff: { kind: "noul", probability: 0.02 },
				optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
				action_accomplished_step: { kind: "noul", probability: 0.02 },
				conclusions_supported: { kind: "noul", probability: 0.97 },
				scope_violation: { kind: "noul", probability: 0.02 },
				unrelated_behavior_change: { kind: "noul", probability: 0.02 },
				replan_required: { kind: "noul", probability: 0.02 },
				next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
				states_tests_pass: { kind: "choice", choice: "no_current_success", confidence: 0.97 },
				states_committed: { kind: "noul", probability: 0.02 },
				states_pushed: { kind: "noul", probability: 0.02 },
				states_published: { kind: "noul", probability: 0.02 },
				states_files_changed: { kind: "noul", probability: 0.97 },
			} as const;
			const resolveJudgments = {
				changes_model_pools: { kind: "noul", probability: 0.02 },
				local_commits_only: { kind: "noul", probability: 0.02 },
				lifts_delivery_block: { kind: "noul", probability: 0.02 },
				full_handoff: { kind: "noul", probability: 0.02 },
				optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
				step_relevant: { kind: "noul", probability: 0.97 },
				evidence_sufficient_to_act: { kind: "noul", probability: 0.97 },
				unsupported_assumption_present: { kind: "noul", probability: 0.02 },
				route: { kind: "choice", choice: "inspect", confidence: 0.97 },
				action_accomplished_step: { kind: "noul", probability: 0.02 },
				conclusions_supported: { kind: "noul", probability: 0.97 },
				scope_violation: { kind: "noul", probability: 0.02 },
				unrelated_behavior_change: { kind: "noul", probability: 0.02 },
				replan_required: { kind: "noul", probability: 0.02 },
				next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
			} as const;
			world.systemOne.enterPhase("mixed-setup", setupJudgments);
			await withDeadline(
				trace,
				"integration setup turn",
				session.prompt("Set MAX_RETRIES to 5: start a worker on its lane, edit the rootwork lane to 4, commit it."),
				120_000,
			).catch((error: unknown) => {
				throw new Error(`${error instanceof Error ? error.message : String(error)}\n${toolOutcomes(session)}`);
			});
			await withDeadline(trace, "worker handoff", handedOff.promise, 90_000);
			await withDeadline(trace, "worker handoff turn settled", session.waitForForegroundIdle(), 90_000);
			world.systemOne.enterPhase("mixed-resolve", resolveJudgments);
			await withDeadline(
				trace,
				"resolution turn",
				session.prompt("Sync rootwork, resolve the conflict, land it, then replay the worker landing."),
				120_000,
			).catch((error: unknown) => {
				throw new Error(`${error instanceof Error ? error.message : String(error)}\n${toolOutcomes(session)}`);
			});
			await withDeadline(trace, "integration released", integrated.promise, 5_000);

			// Stale replacement after integration. An external atomic save renames a new node over the notes file while a
			// descriptor opened earlier is still held: the root's edit from its earlier read is refused, the held descriptor
			// keeps the bytes of the node it opened, and the path shows the replacement.
			const notesPath = `${HARNESS_PROJECT_CWD}/src/notes.md`;
			let heldDescriptor: number | undefined;
			// Late attempt through the real identity fence. A third worker holds its first request at a gate and ignores the request abort. The owner
			// force-suspends the exact attempt while that request is held and queues the valid-current run behind the physical hold. The stale
			// terminal is emitted after the abort, and only then does the valid-current write run. The stale edit never reaches the lane.
			// The resumed run reports incompletely (matched host receipt) and ends on plaintext with no replacement: the terminal claim keeps
			// the typed incomplete report, adverse and not unparseable. A follow-up on the same persistent agent then writes the module and
			// reports truthfully, and that handoff must carry the admitted identity.
			const lateReached = createBarrier();
			const lateMayEmit = createBarrier();
			const lateTerminal = createBarrier();
			let staleTerminalEmitted = false;
			let lateWriteAfterStaleTerminal = false;
			const lateCurrentStarted = createBarrier();
			const lateAdverse = createBarrier();
			const lateRepairStarted = createBarrier();
			const lateHanded = createBarrier();
			let lateAgentId: string | undefined;
			let lateLane: string | undefined;
			let lateLaneBefore: string | undefined;
			let lateRepairTaskId: string | undefined;
			// Claim-delivery judgments: System One asks for these only while a worker's claim is delivered, so only late-attempt declares them.
			const lateClaimJudgments = {
				states_tests_pass: { kind: "choice", choice: "no_current_success", confidence: 0.97 },
				states_committed: { kind: "noul", probability: 0.02 },
				states_pushed: { kind: "noul", probability: 0.02 },
				states_published: { kind: "noul", probability: 0.02 },
				states_files_changed: { kind: "noul", probability: 0.02 },
			} as const;
			const lateJudgments = {
				changes_model_pools: { kind: "noul", probability: 0.02 },
				local_commits_only: { kind: "noul", probability: 0.02 },
				lifts_delivery_block: { kind: "noul", probability: 0.02 },
				full_handoff: { kind: "noul", probability: 0.02 },
				optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
				step_relevant: { kind: "noul", probability: 0.97 },
				evidence_sufficient_to_act: { kind: "noul", probability: 0.97 },
				unsupported_assumption_present: { kind: "noul", probability: 0.02 },
				route: { kind: "choice", choice: "reason", confidence: 0.97 },
				action_accomplished_step: { kind: "noul", probability: 0.97 },
				conclusions_supported: { kind: "noul", probability: 0.97 },
				scope_violation: { kind: "noul", probability: 0.02 },
				unrelated_behavior_change: { kind: "noul", probability: 0.02 },
				replan_required: { kind: "noul", probability: 0.02 },
				next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
			} as const;
			// Each correction is bound to the current host request (the suffix after the newest assistant turn), not the whole history.
			const reviewLine = "changed files with no explanation: src/late.ts";
			const recordedLine = "Files the host recorded as changed: src/late.ts";
			world.systemOne.enterPhase("late-attempt", { ...lateJudgments, ...lateClaimJudgments });
			world.provider.enqueue(
				"worker-b",
				{
					name: "late-edit",
					gate: lateMayEmit.promise,
					ignoresAbort: true,
					check: () => {
						lateReached.release();
					},
					onTerminal: () => {
						staleTerminalEmitted = true;
						lateTerminal.release();
					},
					reply: {
						content: [
							{ type: "text", text: "LATE-STALE-TEXT: the late edit is ready." },
							{
								type: "toolCall",
								id: "late-edit-1",
								name: "edit",
								arguments: {
									path: "src/limits.ts",
									edits: [{ oldText: "MAX_RETRIES = 5", newText: "MAX_RETRIES = 7" }],
								},
							},
						],
						stopReason: "toolUse",
					},
				},
				{
					name: "late-write",
					check: () => {
						if (!staleTerminalEmitted) {
							throw new Error("the valid-current write started before the stale terminal was emitted");
						}
						lateWriteAfterStaleTerminal = true;
						lateCurrentStarted.release();
					},
					reply: {
						content: [
							{
								type: "toolCall",
								id: "late-write-1",
								name: "write",
								arguments: { path: "src/late.ts", content: "export const LATE = true;\n" },
							},
						],
						stopReason: "toolUse",
					},
				},
				{
					name: "late-incomplete",
					reply: {
						content: [
							{
								type: "toolCall",
								id: "late-report-0",
								name: "submit_report",
								arguments: { status: "completed", summary: "LATE-INCOMPLETE-REPORT: the module is written." },
							},
						],
						stopReason: "toolUse",
					},
				},
				{
					name: "late-correction",
					check: (request) => {
						if (!currentRequestCarries(request, "REPORT REVIEW") || !currentRequestCarries(request, reviewLine)) {
							throw new Error("the repair request does not review the unreported change");
						}
						if (!matchedSubmitReceipt(request, "late-report-0")) {
							throw new Error("the incomplete report has no matched completed host receipt for its call");
						}
					},
					reply: { content: [{ type: "text", text: "LATE-PLAINTEXT-CORRECTION: the module is written." }] },
				},
				{
					name: "late-correction-final",
					check: (request) => {
						if (
							!currentRequestCarries(request, "REPORT REQUEST") ||
							!currentRequestCarries(request, "You declared the task done.") ||
							!currentRequestCarries(request, recordedLine)
						) {
							throw new Error("the second request is not the generic report request for the recorded change");
						}
					},
					reply: { content: [{ type: "text", text: "LATE-PLAINTEXT-FINAL: no report follows." }] },
				},
				{
					name: "late-correction-3",
					check: (request) => {
						if (
							!currentRequestCarries(request, "REPORT REQUEST") ||
							!currentRequestCarries(
								request,
								"You answered in text. Submit the same report with the submit_report tool",
							) ||
							!currentRequestCarries(request, recordedLine)
						) {
							throw new Error("the third request is not the repeated report request for the recorded change");
						}
					},
					reply: { content: [{ type: "text", text: "LATE-PLAINTEXT-ROUND-3: no report follows." }] },
				},
			);
			world.provider.enqueue(
				"root",
				calls("create-late-lane", [
					{
						id: "create-late-1",
						name: "worktree_sync",
						arguments: { action: "create_lane", laneKey: "late", goalId: "retries-goal" },
					},
				]),
				dynamicCalls(
					"start-late",
					(request) => {
						const late = legendPath(request, "p/late");
						lateLane = late;
						lateLaneBefore = utf8Text(world.io.readFileSync(`${late}/src/limits.ts`, "utf8"));
						return [
							{
								id: "start-late-1",
								name: "delegate",
								arguments: {
									action: "start",
									model: { provider: "harness-script", modelId: "worker-b" },
									path: late,
									writePaths: [`${late}/src/limits.ts`, `${late}/src/late.ts`],
									instructions:
										"Set MAX_RETRIES to 7 in src/limits.ts of your checkout, then submit your report.",
								},
							},
						];
					},
					(request) => assertBatchOk(request, "create-late-lane"),
				),
				{
					name: "late-started",
					check: (request) => {
						assertBatchOk(request, "start-late");
						lateAgentId = latestAgentIdForTrack(request, "worker-b");
					},
					reply: { content: [{ type: "text", text: "The late worker is running." }] },
				},
				{
					name: "late-adverse",
					check: (request) => {
						const adverse = request.context.messages
							.map((message) => JSON.stringify(message))
							.find((text) => text.includes("LATE-INCOMPLETE-REPORT") && text.includes("terminal handoff"));
						if (adverse === undefined) {
							throw new Error(
								"the incomplete run's terminal handoff does not carry its typed incomplete report",
							);
						}
						if (adverse.includes("unparseable_output")) {
							throw new Error("the incomplete run's terminal claim degraded to unparseable output");
						}
						const view = session.backgroundLanes
							.listWorkerAgents()
							.find((agent) => agent.agentId === lateAgentId);
						if (view?.hostVerdict?.verdict !== "needs_more") {
							throw new Error(
								`the host verdict of the incomplete run is ${view?.hostVerdict?.verdict ?? "absent"}`,
							);
						}
						lateAdverse.release();
					},
					reply: { content: [{ type: "text", text: "The late worker ended incomplete." }] },
				},
				{
					name: "late-handoff",
					check: (request) => {
						const truthful = request.context.messages
							.map((message) => JSON.stringify(message))
							.find((text) => text.includes("LATE-CURRENT-REPORT") && text.includes("terminal handoff"));
						if (truthful === undefined) {
							throw new Error("the follow-up's report did not reach the foreground root");
						}
						// Two facts, asserted separately. The typed report is accepted by the host (Claim Status completed, Host verdict accepted).
						// The overall line is partial because the lane holds this worker's uncommitted change (host finding, intentional).
						// The handoff cuts each blocker value at 120 characters, so the visible integration note is the lane's opening clause.
						const identity = `- ${lateRepairTaskId}: partial reason=worker_host_findings`;
						if (
							lateRepairTaskId === undefined ||
							!truthful.includes(identity) ||
							!truthful.includes("Claim Status: completed") ||
							!truthful.includes("Host verdict: accepted") ||
							truthful.split("LATE-CURRENT-REPORT").length !== 2 ||
							!truthful.includes("Changed Files (untrusted worker evidence)") ||
							!truthful.includes("src/late.ts") ||
							!truthful.includes("worker_lane: this worker worked in its own worktree lane 'late'") ||
							truthful.includes("unparseable_output")
						) {
							throw new Error(
								`the follow-up's claim is not the admitted accepted claim of ${lateRepairTaskId ?? "no task"}: ${truthful.slice(0, 4000)}`,
							);
						}
						lateHanded.release();
					},
					reply: { content: [{ type: "text", text: "The late report is reported." }] },
				},
			);
			await withDeadline(trace, "late worker started", session.prompt("Start a late worker on a third lane."));
			trace.mark("root", "late.started");
			await withDeadline(trace, "late request held", lateReached.promise, 60_000);
			if (lateAgentId === undefined || lateLane === undefined || lateLaneBefore === undefined) {
				throw new Error("the late worker identity or lane was not captured");
			}
			expect(lateLaneBefore, "the late lane was created from the landed value 5").toBe(
				"export const MAX_RETRIES = 5;\n",
			);
			const suspended = session.backgroundLanes.interruptWorkerAgent(lateAgentId, undefined, { force: true });
			expect(suspended, "the exact attempt is force-suspended while its request is held").toEqual({
				interrupted: true,
				mode: "suspend",
			});
			// The valid current attempt is queued behind the stale attempt's physical hold and runs no request before the stale terminal.
			const queued = session.backgroundLanes.resumeWorkerAgent(lateAgentId);
			expect(queued.started, "the valid current attempt is queued behind the physical hold").toBe(true);
			expect(world.provider.reached, "no valid current request runs while the stale attempt is held").not.toContain(
				"worker-b:late-write",
			);
			lateMayEmit.release();
			await withDeadline(trace, "late terminal emitted", lateTerminal.promise, 60_000);
			expect(
				world.provider.terminals.filter(
					(terminal) => terminal.modelId === "worker-b" && terminal.ignoredRequestAbort,
				),
				"the late terminal was emitted after the abort it ignored",
			).toEqual([
				expect.objectContaining({ requestAborted: true, ignoredRequestAbort: true, stopReason: "toolUse" }),
			]);
			expect(world.io.readFileSync(`${lateLane}/src/limits.ts`, "utf8"), "the fence drops the late edit").toBe(
				lateLaneBefore,
			);
			expect(
				JSON.stringify(world.provider.requests.filter((request) => request.model.id === "root")),
				"no root turn sees the stale terminal",
			).not.toContain("LATE-STALE-TEXT");
			await withDeadline(trace, "resumed run writes", lateCurrentStarted.promise, 60_000);
			await withDeadline(trace, "incomplete run ends adverse", lateAdverse.promise, 60_000);
			await withDeadline(trace, "adverse foreground settled", session.waitForForegroundIdle(), 60_000);
			trace.mark("root", "late.adverse");
			// Native durable-reader control on the adverse attempt: the production lifecycle reopens the persisted event store, the store
			// opens the attempt's persisted conversation, and the real recovery coordinator reads its terminal completion. Only that read
			// is invoked: every scheduling and publication port throws if reached. This is a durable-reader control, not a normal resume.
			const adverseProjection = session.backgroundLanes.getTaskRuntimeSnapshot();
			if (adverseProjection === undefined) throw new Error("the task runtime projection is not readable");
			// The adverse attempt is the one terminal attempt of the late agent: any other match is ambiguous and refuses the control.
			const lateTerminalAttempts = Object.values(adverseProjection.attempts).filter(
				(attempt) =>
					(attempt.agentId ?? attempt.dispatch.logicalLaneId) === lateAgentId && attempt.status !== "queued",
			);
			if (lateTerminalAttempts.length !== 1) {
				throw new Error(`the late agent has ${lateTerminalAttempts.length} terminal attempts, not exactly one`);
			}
			const adverseAttempt = lateTerminalAttempts[0];
			if (adverseAttempt === undefined) throw new Error("the adverse attempt is not in the projection");
			const adverseBindingKey = adverseAttempt.agentId ?? adverseAttempt.dispatch.logicalLaneId;
			if (adverseBindingKey === undefined) throw new Error("the adverse attempt names no agent");
			const adverseBinding = adverseProjection.agents[adverseBindingKey];
			if (adverseBinding?.resumeContext === undefined)
				throw new Error("the adverse agent has no persisted resume context");
			const unusedPort = (name: string) => (): never => {
				throw new Error(`the recovery reader control must not invoke ${name}`);
			};
			const readerWarnings: string[] = [];
			const readerLifecycle = new WorkerLifecycle({
				agentDir: world.agentDir,
				sessionId: created.sessionManager.getSessionId(),
			});
			const readerCoordinator = new WorkerRecoveryCoordinator({
				lifecycle: readerLifecycle,
				scheduler: { enqueue: unusedPort("scheduler.enqueue") },
				recoverWriteReservations: unusedPort("recoverWriteReservations"),
				publishTerminalRecord: unusedPort("publishTerminalRecord"),
				dispatchVerification: unusedPort("dispatchVerification"),
				recoverTaskBearingMailboxTurns: unusedPort("recoverTaskBearingMailboxTurns"),
				recoverSessionRootReplies: unusedPort("recoverSessionRootReplies"),
				warn: (message) => {
					readerWarnings.push(message);
				},
			});
			const adverseConversation = new WorkerConversationStore().open({
				agentDir: world.agentDir,
				resumeContext: adverseBinding.resumeContext,
				expectedLogicalAgentId: adverseBinding.contextOrigin?.logicalAgentId ?? adverseBinding.agentId,
			});
			const recovered = readerCoordinator.recoveredTerminalCompletion(adverseConversation, adverseAttempt.attemptId);
			expect(recovered?.attemptId, "the recovered completion names the exact adverse attempt").toBe(
				adverseAttempt.attemptId,
			);
			expect(recovered?.submittedReport?.summary, "the recovered report is the typed incomplete report").toContain(
				"LATE-INCOMPLETE-REPORT",
			);
			expect(
				readerCoordinator.recoveredTerminalCompletion(adverseConversation, "attempt-foreign-not-in-transcript"),
				"a foreign attempt id is refused",
			).toBeUndefined();
			expect(readerWarnings, "the reader control emits no warnings").toEqual([]);

			// The same persistent agent takes a new turn: its write is the current evidence, and its truthful report is the admitted repair.
			// The old phase is physically queued-empty before the distinct repair is appended: no worker-b step from it can serve the follow-up.
			expect(
				world.provider.getPendingStepNames("worker-b"),
				"the old worker-b phase is fully drained before the repair is appended",
			).toEqual([]);
			world.provider.enqueue(
				"worker-b",
				{
					name: "late-repair-write",
					check: () => {
						lateRepairStarted.release();
					},
					reply: {
						content: [
							{
								type: "toolCall",
								id: "late-repair-write-1",
								name: "write",
								arguments: { path: "src/late.ts", content: "export const LATE = true;\n" },
							},
						],
						stopReason: "toolUse",
					},
				},
				calls("late-current", [
					{
						id: "late-report-1",
						name: "submit_report",
						arguments: {
							status: "completed",
							summary: "LATE-CURRENT-REPORT: the lane is reported.",
							changes: [{ file: "src/late.ts", what: "Exports the LATE flag from the late module." }],
						},
					},
				]),
			);
			const repair = session.backgroundLanes.followUpSessionRootWorkerAgent(
				lateAgentId,
				"Submit the corrected report with the module change.",
				{
					idempotencyKey: "late-repair-1",
				},
			);
			expect(repair.started, "the follow-up admits a new turn on the same persistent agent").toBe(true);
			lateRepairTaskId = repair.record?.laneId;
			if (lateRepairTaskId === undefined) throw new Error("the follow-up admitted no task");
			await withDeadline(trace, "repair write starts", lateRepairStarted.promise, 60_000);
			await withDeadline(trace, "truthful handoff", lateHanded.promise, 60_000);
			await withDeadline(trace, "late handoff settled", session.waitForForegroundIdle(), 60_000);
			const admitted = Object.values(session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {}).filter(
				(attempt) => attempt.taskId === lateRepairTaskId,
			);
			expect(
				admitted.map((attempt) => attempt.status),
				"the admitted current attempt is partial: the host finding holds the uncommitted lane change",
			).toEqual(["partial"]);
			// Native proof of the admitted repair. The handoff renders each blocker clipped, so the uncommitted integration finding is read
			// from the persisted result in full, with the exact marker, and from the agent's latest host verdict.
			const repairResult = session.backgroundLanes.getWorkerResult(lateRepairTaskId);
			expect(repairResult?.status, "the repair result is partial because of the host finding").toBe("partial");
			expect(repairResult?.summary, "the repair result carries the current report").toContain("LATE-CURRENT-REPORT");
			expect(
				repairResult?.errors.map((error) => error.message),
				"the host finding names the lane and the uncommitted integration change",
			).toEqual(expect.arrayContaining([expect.stringContaining("its changes are there: uncommitted changes")]));
			const lateSnapshot = session.backgroundLanes.getTaskRuntimeSnapshot();
			const lateView = session.backgroundLanes.listWorkerAgents().find((agent) => agent.agentId === lateAgentId);
			const lateDiagnostic = JSON.stringify({
				view: {
					hostVerdict: lateView?.hostVerdict,
					lastResult: lateView?.lastResult,
					dispatch: lateView?.dispatch,
					recommendedDisposition: lateView?.recommendedDisposition,
				},
				attempts: Object.values(lateSnapshot?.attempts ?? {})
					.filter((attempt) => (attempt.agentId ?? attempt.dispatch.logicalLaneId) === lateAgentId)
					.map((attempt) => ({
						attemptId: attempt.attemptId,
						taskId: attempt.taskId,
						status: attempt.status,
						logicalLaneId: attempt.dispatch.logicalLaneId,
						result: attempt.result?.status,
					})),
				repairTaskId: lateRepairTaskId,
			});
			expect(
				lateView?.hostVerdict?.verdict,
				`the agent's latest report is accepted by the host: ${lateDiagnostic}`,
			).toBe("accepted");
			// The superseded adverse turn's unreported-change finding must not survive into the current view's verdict or advice.
			expect(
				JSON.stringify({ missing: lateView?.hostVerdict?.missing ?? [], advice: lateView?.recommendedDisposition }),
				"the latest view carries no reason from the superseded unreported-change turn",
			).not.toMatch(/unreported|no explanation/);
			expect(
				world.io.readFileSync(`${lateLane}/src/limits.ts`, "utf8"),
				"the stale edit never reached the limits",
			).toBe(lateLaneBefore);
			expect(world.io.readFileSync(`${lateLane}/src/late.ts`, "utf8"), "the current attempt wrote its module").toBe(
				"export const LATE = true;\n",
			);
			expect(lateWriteAfterStaleTerminal, "the valid-current write ran after the stale terminal").toBe(true);
			trace.mark("root", "late.reported");

			// Integration and completion: the late lane's module lands, both delegated workers retire, and the goal completes on the
			// host after a passing run is recorded as evidence. Completion is refused while a goal-owned lane is still active.
			const integrateVitest = "vitest run test/limits.test.ts";
			const integrationVitestOutput = ["Test Files  1 passed (1)\n", "Tests  1 passed (1)\n"];
			world.shell.enqueue({
				name: "vitest-pass-integration",
				command: integrateVitest,
				output: integrationVitestOutput,
				exitCode: 0,
				check: () => {
					if (world.io.readFileSync(LIMITS_PATH, "utf8") !== "export const MAX_RETRIES = 5;\n") {
						throw new Error("the run saw a limits value other than 5");
					}
					if (
						world.io.readFileSync(`${HARNESS_PROJECT_CWD}/src/late.ts`, "utf8") !== "export const LATE = true;\n"
					) {
						throw new Error("the run saw no landed late module");
					}
				},
			});
			world.systemOne.enterPhase("integrate", {
				...lateJudgments,
			});
			world.provider.enqueue(
				"root",
				calls("integrate-late", [
					{
						id: "add-late-1",
						name: "worktree_sync",
						arguments: { action: "git_add", laneKey: "late", paths: ["src/late.ts"] },
					},
					{
						id: "commit-late-1",
						name: "worktree_sync",
						arguments: { action: "git_commit", laneKey: "late", message: "Add the late module" },
					},
				]),
				{
					name: "land-late",
					check: (request) => {
						assertBatchOk(request, "integrate-late");
					},
					reply: {
						content: [
							{
								type: "toolCall",
								id: "land-late-1",
								name: "worktree_sync",
								arguments: { action: "land", laneKey: "late" },
							},
						],
						stopReason: "toolUse",
					},
				},
				{
					name: "late-landed",
					check: (request) => {
						const landed = latestBatchResults(request).find((result) => result.text.includes("LANDED"));
						if (!landed)
							throw new Error(`the late lane did not land: ${JSON.stringify(latestBatchResults(request))}`);
					},
					reply: { content: [{ type: "text", text: "The late module landed." }] },
				},
			);
			await withDeadline(trace, "integration turn", session.prompt("Integrate the late lane's module."));
			trace.mark("root", "late.integrated");
			world.systemOne.enterPhase("complete", {
				...lateJudgments,
				shows_true_0: { kind: "noul", probability: 0.97 },
				shows_false_0: { kind: "noul", probability: 0.02 },
				shows_true_1: { kind: "noul", probability: 0.97 },
				shows_false_1: { kind: "noul", probability: 0.02 },
				shows_true_2: { kind: "noul", probability: 0.97 },
				shows_false_2: { kind: "noul", probability: 0.02 },
				shows_true_3: { kind: "noul", probability: 0.97 },
				shows_false_3: { kind: "noul", probability: 0.02 },
				shows_true_4: { kind: "noul", probability: 0.97 },
				shows_false_4: { kind: "noul", probability: 0.02 },
				shows_true_5: { kind: "noul", probability: 0.97 },
				shows_false_5: { kind: "noul", probability: 0.02 },
				shows_true_6: { kind: "noul", probability: 0.97 },
				shows_false_6: { kind: "noul", probability: 0.02 },
				outcomes_achieved: { kind: "noul", probability: 0.97 },
				required_behavior_unverified: { kind: "noul", probability: 0.02 },
				material_claim_unsupported: { kind: "noul", probability: 0.02 },
				missing_requirement: { kind: "noul", probability: 0.02 },
			});
			world.provider.enqueue(
				"root",
				dynamicCalls("retire-workers", (request) => [
					{
						id: "retire-a-1",
						name: "delegate",
						arguments: { action: "retire", agentId: latestAgentIdForTrack(request, "worker-a") },
					},
					{
						id: "retire-b-1",
						name: "delegate",
						arguments: { action: "retire", agentId: latestAgentIdForTrack(request, "worker-b") },
					},
				]),
				{
					name: "workers-retired",
					check: (request) => {
						const retirements = latestBatchResults(request).filter((result) => result.toolName === "delegate");
						if (
							retirements.length !== 2 ||
							retirements.some((result) => result.isError || !result.text.includes("retired"))
						) {
							throw new Error(`the delegated workers were not both retired: ${JSON.stringify(retirements)}`);
						}
					},
					reply: {
						content: [
							{
								type: "toolCall",
								id: "goal-req-1",
								name: "goal",
								arguments: {
									action: "add_requirement",
									text: "MAX_RETRIES equals 5 and the late module lands",
								},
							},
						],
						stopReason: "toolUse",
					},
				},
				calls("goal-read", [{ id: "goal-read-1", name: "goal", arguments: { action: "get" } }]),
				calls("vitest-integration", [
					{ id: "verify-integration-1", name: "bash", arguments: { command: integrateVitest } },
				]),
				dynamicCalls(
					"add-integration-evidence",
					(request) => [
						{
							id: "evidence-integration-1",
							name: "goal",
							arguments: {
								action: "add_evidence",
								kind: "test",
								uri: "verify-integration-1",
								summary: "vitest passed: MAX_RETRIES is 5 and the late module is landed",
								requirementIds: [requirementIdOf(request)],
							},
						},
					],
					(request) => assertBatchOk(request, "vitest-integration"),
				),
				dynamicCalls("complete-goal", (request) => {
					const ids = evidenceIdsOf(request);
					const requirement = requirementIdOf(request);
					return [
						{
							id: "complete-goal-1",
							name: "goal",
							arguments: {
								action: "complete",
								account: {
									changes: [
										{
											path: "src/limits.ts",
											reason: "Raises MAX_RETRIES to 5 for the retries lane.",
											serves: [requirement],
										},
										{
											path: "src/late.ts",
											reason: "Exports the LATE flag from the late module.",
											serves: [requirement],
										},
									],
									assumptions: [{ claim: "the limits test checks the retry count", evidenceIds: [ids[0]] }],
									regressions: [
										{ path: "src/limits.ts", evidenceIds: [ids[0]] },
										{ path: "src/late.ts", evidenceIds: [ids[0]] },
									],
								},
							},
						},
					];
				}),
				{
					name: "goal-completed",
					check: (request) => {
						assertBatchOk(request, "complete-goal");
						if (!latestBatchResults(request).some((result) => result.text.includes("goal complete recorded"))) {
							throw new Error("the host did not record the goal as complete");
						}
					},
					reply: { content: [{ type: "text", text: "The goal is complete." }] },
				},
			);
			await withDeadline(
				trace,
				"retirement and completion turn",
				session.prompt("Retire the workers and complete the goal."),
			);
			trace.mark("root", "goal.completed");

			world.provider.enqueue(
				"root",
				calls("read-notes", [{ id: "read-notes-1", name: "read", arguments: { path: notesPath } }]),
				{
					name: "stale-edit",
					check: () => {
						heldDescriptor = world.io.openSync(notesPath, "r");
						world.io.writeFileSync(`${notesPath}.tmp`, "stage two\n");
						world.io.renameSync(`${notesPath}.tmp`, notesPath);
					},
					reply: {
						content: [
							{
								type: "toolCall",
								id: "stale-edit-1",
								name: "edit",
								arguments: { path: notesPath, edits: [{ oldText: "stage one", newText: "stage three" }] },
							},
						],
						stopReason: "toolUse",
					},
				},
				{
					name: "stale-edit-refused",
					check: (request) => {
						const edit = latestBatchResults(request).find((result) => result.toolName === "edit");
						if (!edit?.isError || !edit.text.includes("Could not find the exact text")) {
							throw new Error(`the stale edit was not refused: ${edit?.text ?? "no edit result"}`);
						}
					},
					reply: { content: [{ type: "text", text: "The stale edit was refused." }] },
				},
			);
			await withDeadline(
				trace,
				"stale replacement turn",
				session.prompt("Change the stage one line of the notes file."),
			);
			if (heldDescriptor === undefined) throw new Error("the held descriptor was never opened");
			expect(world.readDescriptorText(heldDescriptor, 64), "a held descriptor keeps the node it opened").toBe(
				"stage one\n",
			);
			world.closeDescriptor(heldDescriptor);
			expect(world.io.readFileSync(notesPath, "utf8"), "the path shows the replacement").toBe("stage two\n");

			// The refused edit is followed by a successful read before the restart: the refusal is resolved by the next successful call.
			world.provider.enqueue(
				"root",
				calls("reread-notes", [{ id: "reread-notes-1", name: "read", arguments: { path: notesPath } }]),
				text("reread-reported", "The notes file is read again."),
			);
			// The refused edit is still an active recovery record, so the loop asks the model once more after the reply.
			await withDeadline(trace, "notes re-read turn", session.prompt("Re-read the notes file."));
			// Restart. The root session is disposed, then reopened from its persisted file by its owner. The reopened session's
			// first request must carry every legend line the first session showed: alias ids are restored, not re-minted.
			// The first session is disposed once the goal is complete: no admission or work-remaining question is pending.
			// The goal is complete: disposing the first session asks no admission or work-remaining question.
			world.systemOne.enterPhase("restart-disposal", {});
			expect(
				await world.disposeSessionInBody(session),
				"the root session must dispose before the restart",
			).toBeUndefined();
			const rootFile = created.sessionManager.getSessionFile();
			if (rootFile === undefined) throw new Error("the mixed root session has no file");
			const restarted = (
				await world.createRootSession("root", { sessionManager: world.openSessionManager(rootFile) })
			).session;
			// The restored prompt is a new root turn: its post-flight stage asks the turn-outcome questions, and the answer is a
			// completed step with its conclusions supported.
			// The restored prompt's admission does not ask whether the grounding is sufficient: the disposal above asks it.

			// The restored prompt is a new root turn: its post-flight stage asks the turn-outcome questions; the completed goal leaves no open work.
			world.systemOne.enterPhase("restart", {
				step_relevant: { kind: "noul", probability: 0.97 },
				evidence_sufficient_to_act: { kind: "noul", probability: 0.97 },
				unsupported_assumption_present: { kind: "noul", probability: 0.02 },
				route: { kind: "choice", choice: "reason", confidence: 0.97 },
				action_accomplished_step: { kind: "noul", probability: 0.97 },
				conclusions_supported: { kind: "noul", probability: 0.97 },
				scope_violation: { kind: "noul", probability: 0.02 },
				unrelated_behavior_change: { kind: "noul", probability: 0.02 },
				replan_required: { kind: "noul", probability: 0.02 },
				next_status: { kind: "choice", choice: "completion_candidate", confidence: 0.97 },
			});
			world.provider.enqueue("root", {
				name: "restored-legend",
				check: (request) => {
					const lines = legendLinesOf(request);
					if (legendAtIntegration.length === 0) throw new Error("no legend was shown before the restart");
					const missing = legendAtIntegration.filter((line) => !lines.includes(line));
					if (missing.length > 0)
						throw new Error(`the restored request lost legend lines: ${missing.join(" | ")}`);
				},
				reply: { content: [{ type: "text", text: "Restored and continuing." }] },
			});
			await withDeadline(trace, "restored root turn", restarted.prompt("Continue after the restart."));
			trace.mark("root", "restart.reply");
			await withDeadline(trace, "restored foreground settled", restarted.waitForForegroundIdle(), 60_000);

			expect(world.io.readFileSync(`${HARNESS_PROJECT_CWD}/src/limits.ts`, "utf8"), toolOutcomes(session)).toBe(
				"export const MAX_RETRIES = 5;\n",
			);
			expect(world.io.readFileSync(`${HARNESS_PROJECT_CWD}/src/owner.md`, "utf8")).toBe(OWNER_DRAFT_DIRTY);
		},
	);
}, 180_000);
