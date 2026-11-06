import { join } from "node:path";
import { expect } from "vitest";
import { getBundledResourcesDir } from "../../../../src/config.ts";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { OUTWARD_DRAFT_CUSTOM_TYPE, type OutwardDraftRecord } from "../../../../src/core/agent-session-edge.ts";
import { piChatExtension } from "../../../../src/core/chat/extension.ts";
import { sessionMeshId } from "../../../../src/core/chat/identity.ts";
import type { AgentSendResult } from "../../../../src/core/chat/mesh.ts";
import type { ExtensionRunner } from "../../../../src/core/extensions/runner.ts";
import { emitSessionShutdownEvent } from "../../../../src/core/extensions/runner.ts";
import type { ExtensionUIContext } from "../../../../src/core/extensions/types.ts";
import { HARNESS_NOTICE_CUSTOM_TYPE } from "../../../../src/core/harness-notice.ts";
import { MessageInbox } from "../../../../src/core/messaging/inbox.ts";
import { ORCHESTRATION_SCHEMA_VERSION } from "../../../../src/core/orchestration/contracts.ts";
import { OrchestrationProfileStore } from "../../../../src/core/orchestration/profile-store.ts";
import type { Settings } from "../../../../src/core/settings/settings-schema.ts";
import { entryTurnOrigin } from "../../../../src/core/turn-origin.ts";
import { parentInputOriginalDetails } from "../../../../src/kernel/session/parent-input-ledger.ts";
import type { SessionManager } from "../../../../src/kernel/session/session-manager.ts";
import { calls, createBarrier } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { latestBatchResults } from "./shared.ts";

const TOOL_TIMEOUT_MS = 10_000;
const READER_PROFILE_ID = "pi-chat-reader";

async function callTool(session: AgentSession, name: string, params: Record<string, unknown>) {
	const definition = session.getToolDefinition(name);
	if (definition === undefined) throw new Error(`the session offers no ${name} tool`);
	// pi-chat's tools read their parameters only; the host context they are handed is unused.
	const result = await definition.execute(
		`pi-chat-leg-${name}`,
		params as never,
		undefined,
		undefined,
		undefined as never,
	);
	const first = result.content[0];
	return { text: first?.type === "text" ? first.text : "", details: result.details };
}

/**
 * pi-chat addresses the pi session and holds mail for a peer that is away. Two root sessions join one mesh over the world's
 * in-memory network: a live message reaches the peer (the control); the peer's session ends and is resumed under the same
 * session id; a message sent while it is away is held in its inbox, reported as queued and, sent again with its messageId,
 * as queued still; the resumed session re-claims its id with the credential it kept and takes the held message once,
 * with the sender's standing attested; a later send of the same messageId is acknowledged without a second turn; mail
 * forged into the inbox arrives as an unverified peer; a push a verified peer asks a third session for is prepared for that
 * session's owner (one draft, one notice, no shell request) while the same push runs on the owner's own turn and,
 * after the owner's own grant, in the peer's run; a worker a peer's run delegates carries the peer's origin, is offered
 * none of the owner's memory and reports into a third-party run, while the owner's own worker keeps its memory tool and
 * reports as the owner's automation; and no message body is stored once its message is settled or written
 * to the audit log.
 */
export async function runJourney1PiChatPhase(world: HarnessWorld): Promise<void> {
	const { trace } = world;
	const stateRoot = `${world.agentDir}-pi-chat-state`;
	const agentDirA = `${world.agentDir}-pi-chat-a`;
	const agentDirB = `${world.agentDir}-pi-chat-b`;
	const managerA = world.createSessionManager(agentDirA);
	const managerB = world.createSessionManager(agentDirB);
	const settings = { memorySystem: "okf", autoLearn: { enabled: false } } as const;
	const extensionErrors: string[] = [];
	const notices: string[] = [];
	// The host copies the UI context's own properties, so this phase supplies a concrete object: the scripted human's
	// question presentation plus the two operations the extension drives (a recorded notification and a status line).
	const ui = {
		askQuestions: world.humanInput.ui.askQuestions,
		notify: (message: string) => void notices.push(message),
		setStatus: () => undefined,
	} as unknown as ExtensionUIContext;
	/** The status of the one target, with the whole result and any extension error as the assertion's evidence. */
	const expectStatus = (result: { readonly details: unknown }, expected: string, label: string): void => {
		const sent = result.details as AgentSendResult;
		expect(
			sent.targets[0]?.status,
			`${label}: ${JSON.stringify(sent)} errors=${JSON.stringify(extensionErrors)}`,
		).toBe(expected);
	};
	const runners = new Map<AgentSession, () => ExtensionRunner>();
	const open = async (
		manager: SessionManager,
		agentDir: string,
		own: { readonly settings?: Partial<Settings>; readonly systemOneEnabled?: boolean } = {},
	): Promise<AgentSession> => {
		const created = await world.createRootSession("root", {
			agentDir,
			sessionManager: manager,
			settings: { ...settings, ...own.settings },
			...(own.systemOneEnabled !== undefined ? { systemOneEnabled: own.systemOneEnabled } : {}),
			extensionFactories: [(pi) => piChatExtension(pi, { stateRoot })],
		});
		await created.session.bindExtensions({
			uiContext: ui,
			onError: (error) => extensionErrors.push(`${error.event}: ${error.error}`),
		});
		runners.set(created.session, created.getExtensionRunner);
		return created.session;
	};
	const dispose = async (session: AgentSession, label: string): Promise<void> => {
		// A session's owner runs its extensions' shutdown (where pi-chat leaves the mesh) before the session is disposed.
		const runner = runners.get(session);
		if (runner === undefined) throw new Error(`${label}: the session was not opened by this phase`);
		await emitSessionShutdownEvent(runner(), { type: "session_shutdown", reason: "quit" });
		expect(await world.disposeSessionInBody(session), label).toBeUndefined();
	};

	if (process.platform === "win32") {
		// The local mesh has no transport on native Windows: the extension registers /pi-chat only, and no tool.
		const only = await open(managerA, agentDirA);
		expect(only.getToolDefinition("agent_send"), "win32: no agent_send").toBeUndefined();
		expect(only.getToolDefinition("list_peers"), "win32: no list_peers").toBeUndefined();
		await dispose(only, "win32 session disposal");
		return;
	}

	// The packaged resource directory the extension points the loader at: the world has a virtual tree, so it holds the skill too.
	world.io.seed(
		join(getBundledResourcesDir(), "extensions", "pi-chat", "skills", "pi-chat", "SKILL.md"),
		'---\nname: pi-chat\ndescription: "Use when coordinating with other pi agents over pi-chat."\n---\n\n# Pi Chat\n',
	);
	const meshIdA = sessionMeshId(managerA.getSessionId());
	const meshIdB = sessionMeshId(managerB.getSessionId());
	const inboxDir = `${stateRoot}/inbox`;
	const taken: string[] = [];
	const expectTurn = (name: string, reply: string) => {
		const reached = createBarrier();
		world.provider.enqueue("root", {
			name,
			check: (request) => {
				taken.push(JSON.stringify(request.context.messages));
				reached.release();
			},
			reply: { content: [{ type: "text", text: reply }] },
		});
		return reached;
	};

	// The first session on the mesh becomes its broker; the second joins it. Each is addressed by its own session.
	let sessionB = await open(managerB, agentDirB);
	const sessionA = await open(managerA, agentDirA);
	const listed = await callTool(sessionA, "list_peers", {});
	trace.mark("root", "pi-chat.joined");
	expect(listed.text, "A sees B by B's session id").toContain(meshIdB);
	expect(listed.text, "A names itself by its own session id").toContain(`self: `);
	expect(listed.text).toContain(meshIdA);

	// Control: with both sessions on the mesh a message is delivered live, not held.
	const liveTurn = expectTurn("pi-chat-live-turn", "Read the live message.");
	const live = await callTool(sessionA, "agent_send", {
		to: meshIdB,
		message: "live hello from A",
		messageId: "leg-live-1",
		timeoutMs: TOOL_TIMEOUT_MS,
	});
	expectStatus(live, "received", "a live message is received, not queued");
	await withDeadline(trace, "B takes the live message", liveTurn.promise);
	await sessionB.agent.waitForIdle();
	expect(taken.at(-1), "B's turn carries the live message").toContain("live hello from A");
	expect(notices.join("\n"), "B's owner is told a peer message arrived").toContain("pi-chat: message from");
	expect(world.io.existsSync(inboxDir) ? world.io.readdirSync(inboxDir) : [], "a live message holds nothing").toEqual(
		[],
	);

	// B keeps a private credential for its id, so a resumed session can re-claim it.
	const credentialDir = `${stateRoot}/sessions/local/credentials`;
	const credentials = world.io.readdirSync(credentialDir).map(String);
	expect(credentials.length, "one credential file per session on the mesh").toBe(2);
	for (const name of credentials) {
		expect(Number(world.io.statSync(`${credentialDir}/${name}`).mode) & 0o777, "a credential file is private").toBe(
			0o600,
		);
	}

	// B's session ends; the mesh loses its broker and A takes the role on its next send.
	await dispose(sessionB, "B's first disposal");
	const held = await callTool(sessionA, "agent_send", {
		to: meshIdB,
		message: "held for you",
		messageId: "leg-held-1",
		timeoutMs: TOOL_TIMEOUT_MS,
	});
	expectStatus(held, "queued", "a message to an absent peer is queued");
	const again = await callTool(sessionA, "agent_send", {
		to: meshIdB,
		message: "held for you",
		messageId: "leg-held-1",
		timeoutMs: TOOL_TIMEOUT_MS,
	});
	expectStatus(again, "queued", "sending again reports the fate: still queued");
	const changed = await callTool(sessionA, "agent_send", {
		to: meshIdB,
		message: "a different message under the same id",
		messageId: "leg-held-1",
		timeoutMs: TOOL_TIMEOUT_MS,
	});
	expectStatus(changed, "failed", "an id reused for another message is refused");
	const heldFiles = world.io
		.readdirSync(inboxDir)
		.map(String)
		.filter((name) => name.endsWith(".json"));
	expect(heldFiles.length, "one inbox file holds the message").toBe(1);
	const heldPath = `${inboxDir}/${heldFiles[0]}`;
	expect(Number(world.io.statSync(heldPath).mode) & 0o777, "the inbox file is private").toBe(0o600);
	expect(String(world.io.readFileSync(heldPath)), "the body waits in the inbox").toContain("held for you");

	// B's session is resumed under the same session id: it re-claims its id and takes the held message once.
	const resumedTurn = expectTurn("pi-chat-held-turn", "Read the held message.");
	sessionB = await open(managerB, agentDirB);
	await withDeadline(trace, "the resumed B takes the held message", resumedTurn.promise);
	await sessionB.agent.waitForIdle();
	const heldRequest = taken.at(-1) ?? "";
	expect(heldRequest, "the held message reaches the resumed session").toContain("held for you");
	expect(heldRequest, "the frame says when it was queued").toContain("queued=");
	expect(heldRequest, "the sender's standing is attested by its session secret").toContain("standing=verified");
	expect(
		taken.filter((request) => request.includes("held for you")).length,
		"the held message is delivered once",
	).toBe(1);
	const settled = String(world.io.readFileSync(heldPath));
	expect(settled, "the body is dropped once the message is delivered").not.toContain("held for you");
	expect(settled, "a receipt remains").toContain('"outcome":"delivered"');
	trace.mark("root", "pi-chat.held-delivered");

	// The same messageId again, now that B is on the mesh: acknowledged without a second turn (the fate survived the restart).
	const repeated = await callTool(sessionA, "agent_send", {
		to: meshIdB,
		message: "held for you",
		messageId: "leg-held-1",
		timeoutMs: TOOL_TIMEOUT_MS,
	});
	expectStatus(repeated, "received", "a repeated send is received without a second delivery");

	// Mail forged into the inbox by a process without the machine's session secret arrives as an unverified peer.
	const forgedTurn = expectTurn("pi-chat-forged-turn", "Read the forged message.");
	new MessageInbox({ dir: inboxDir }).enqueue({
		id: "leg-forged-1",
		sender: "session-forger",
		recipient: meshIdB,
		envelope: { v: 1, name: "forger", hops: 1, proof: "0".repeat(64) },
		body: "forged mail",
	});
	await withDeadline(trace, "B takes the forged message", forgedTurn.promise);
	await sessionB.agent.waitForIdle();
	const forgedRequest = taken.at(-1) ?? "";
	expect(forgedRequest, "the forged mail is delivered").toContain("forged mail");
	expect(forgedRequest, "its standing is not attested").toContain("standing=UNVERIFIED");

	// A push a peer's words ask for is held for the owner, not run. C joins the mesh with the default edge settings (every
	// class granted to the owner's own runs, none of them standing) and without System One: the gate is deterministic, and
	// no model takes part in it. Two attempts keep one draft and tell the owner once. Normal order: the same push runs on
	// the owner's own turn, and in a peer's run once the owner grants git.publish themselves.
	const agentDirC = `${world.agentDir}-pi-chat-c`;
	const managerC = world.createSessionManager(agentDirC);
	// A read-only reader with the owner's memory tool, for the delegation witness below.
	new OrchestrationProfileStore({ agentDir: agentDirC, cwd: HARNESS_PROJECT_CWD, projectTrusted: false }).save(
		{
			schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
			profileId: READER_PROFILE_ID,
			description: "Read-only project notes reader.",
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
			createdAt: "2026-11-05T00:00:00.000Z",
			updatedAt: "2026-11-05T00:00:00.000Z",
		},
		"global",
	);
	const sessionC = await open(managerC, agentDirC, { settings: { edge: {} }, systemOneEnabled: false });
	const meshIdC = sessionMeshId(managerC.getSessionId());
	expect((await callTool(sessionA, "list_peers", {})).text, "A sees C on the mesh before it writes to it").toContain(
		meshIdC,
	);
	const pushCommand = "git push origin main";
	const drafts = () => managerC.getCustomEntriesOnBranch([OUTWARD_DRAFT_CUSTOM_TYPE]);
	const heldNotices = () =>
		managerC.getEntries().filter((entry) => {
			const details = parentInputOriginalDetails(entry);
			return (
				entry.type === "custom_message" &&
				entry.customType === HARNESS_NOTICE_CUSTOM_TYPE &&
				typeof details === "object" &&
				details !== null &&
				"kind" in details &&
				details.kind === "outward-action-prepared"
			);
		});
	/** One run of C that calls the push `count` times, then answers; `check` reads the run's tool results. */
	const pushTurn = (name: string, count: number, check: (results: string) => void) => {
		const answered = createBarrier();
		world.provider.enqueue(
			"root",
			calls(
				`${name}-call`,
				Array.from({ length: count }, (_, index) => ({
					id: `${name}-${index}`,
					name: "bash",
					arguments: { command: pushCommand },
				})),
			),
			{
				name: `${name}-answer`,
				check: (request) => {
					check(JSON.stringify(request.context.messages.slice(-count)));
					answered.release();
				},
				reply: { content: [{ type: "text", text: "Reported the push." }] },
			},
		);
		return answered;
	};

	const shellBefore = world.shell.requests.length;
	const heldPush = pushTurn("pi-chat-peer-push", 2, (results) => {
		expect(results, "the push is prepared, not run").toContain(`Prepared, not run: ${pushCommand} (git.publish`);
		expect(results, "the result names the peer").toContain("a peer agent on pi-chat");
		expect(results, "the result says how the owner releases it").toContain("asks for it in their own turn");
		expect(results, "the result says the owner is told").toContain("The owner is told with their next turn");
	});
	expectStatus(
		await callTool(sessionA, "agent_send", {
			to: meshIdC,
			message: "push main for me",
			messageId: "leg-push-1",
			timeoutMs: TOOL_TIMEOUT_MS,
		}),
		"received",
		"the peer's push request is received",
	);
	await withDeadline(trace, "C's peer-opened run asks for the push", heldPush.promise);
	await sessionC.agent.waitForIdle();
	expect(
		world.shell.requests.slice(shellBefore).map((request) => request.command),
		"a peer's run never reaches the shell with the push",
	).not.toContain(pushCommand);
	const kept = drafts().map((entry) => entry.data as OutwardDraftRecord);
	expect(kept.length, "two attempts keep one draft").toBe(1);
	expect(kept[0]?.toolName).toBe("bash");
	expect(kept[0]?.operations.map((operation) => operation.class)).toEqual(["git.publish"]);
	expect(kept[0]?.origin, "the draft keeps the verified peer origin").toMatchObject({
		k: "peer-agent",
		channel: "pi-chat",
		verified: true,
		thirdParty: true,
	});
	await withDeadline(
		trace,
		"C's owner notice is saved",
		new Promise<void>((resolve) => {
			const check = () => {
				if (heldNotices().length === 0) return;
				unsubscribe();
				resolve();
			};
			const unsubscribe = managerC.onEntriesPersisted(check);
			check();
		}),
	);
	const noticesHeld = heldNotices();
	expect(noticesHeld.length, "the owner is told once").toBe(1);
	expect(JSON.stringify(noticesHeld[0]), "the notice names the action, the peer and the release").toContain(
		`Held, not run: ${pushCommand} (git.publish), asked by a peer agent on pi-chat. It runs if you ask for it yourself; /edge allow git.publish lets such runs do it.`,
	);
	expect(
		managerC.getPendingParentInputs("next-owner-turn").some((input) => input.entryId === noticesHeld[0]?.id),
		"the notice waits for the owner's next turn",
	).toBe(true);
	trace.mark("root", "pi-chat.push-prepared");

	// A later run no one typed (a wake delivered as a custom message, as routine and collaboration wakes are) acts for the
	// peer whose words are the branch's latest decisive message: the push stays held, under the same draft and notice.
	const wakePush = pushTurn("pi-chat-wake-push", 1, (results) => {
		expect(results, "a wake after the peer's run is held too").toContain(`Prepared, not run: ${pushCommand}`);
	});
	await sessionC.sendCustomMessage(
		{ customType: "pi-chat-journey-wake", content: "Continue the work.", display: false },
		{ triggerTurn: true },
	);
	await withDeadline(trace, "C's wake run asks for the push", wakePush.promise);
	await sessionC.agent.waitForIdle();
	expect(
		world.shell.requests.slice(shellBefore).map((request) => request.command),
		"the wake run never reaches the shell with the push",
	).not.toContain(pushCommand);
	expect(drafts().length, "the wake's attempt is the same held request").toBe(1);
	expect(heldNotices().length, "the owner is still told once").toBe(1);

	// The taint travels with a delegation: once the owner lets peers' runs delegate (their edge command), a worker the
	// peer's run starts carries the peer's origin in its dispatch, is offered none of the owner's memory, and its report
	// opens a third-party run. Normal order: the same reader started on the owner's own turn keeps its memory tool, and
	// its report is the owner's automation.
	sessionC.grantEdge("agent.delegate", "operator", { note: "the owner's edge command" });
	const completionOrigins = () =>
		managerC
			.getEntries()
			.filter(
				(entry) =>
					(entry.type === "custom_message" && entry.customType === "background-worker-completion") ||
					(entry.type === "message" &&
						entry.message.role === "custom" &&
						entry.message.customType === "background-worker-completion"),
			)
			.map((entry) => entryTurnOrigin(entry));
	const attemptsOfC = () => Object.values(sessionC.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {});
	/**
	 * One delegation of the reader: the run starts it and answers, the worker reports, and its report wakes C once. The
	 * attempt is the one the leg started: its dispatch names the profile the host compiled (the preset with the host's own
	 * additions, under a derived id), not the preset id the call selected.
	 */
	const readerLeg = async (label: string, open: () => Promise<unknown>, offeredMemory: boolean) => {
		const answered = createBarrier();
		const reported = createBarrier();
		const woken = createBarrier();
		const before = completionOrigins().length;
		const attemptsBefore = new Set(attemptsOfC().map((attempt) => attempt.attemptId));
		world.provider.enqueue(
			"root",
			calls(`${label}-start`, [
				{
					id: `${label}-start`,
					name: "delegate",
					arguments: {
						action: "start",
						profileId: READER_PROFILE_ID,
						instructions: "Read the project notes and report.",
					},
				},
			]),
			{
				name: `${label}-started`,
				check: (request) => {
					const started = latestBatchResults(request).find((entry) => entry.toolName === "delegate");
					expect(started?.isError, started?.text).toBe(false);
					answered.release();
				},
				reply: { content: [{ type: "text", text: "A reader is started." }] },
			},
			{
				name: `${label}-woken`,
				check: () => woken.release(),
				reply: { content: [{ type: "text", text: "Read the reader's report." }] },
			},
		);
		world.provider.enqueue("worker-a", {
			name: `${label}-reader`,
			// Held until the parent's answer is requested: the report then either joins that run after its answer or opens the
			// next one, one more parent request either way.
			gate: answered.promise,
			check: (request) => {
				const tools = request.context.tools?.map((tool) => tool.name) ?? [];
				if (offeredMemory)
					expect(tools, `${label}: the owner's reader keeps its memory tool`).toContain("memory_read");
				else
					expect(tools, `${label}: a reader for a peer's words reads none of the owner's memory`).not.toContain(
						"memory_read",
					);
				reported.release();
			},
			reply: calls(`${label}-report`, [
				{
					id: `${label}-report`,
					name: "submit_report",
					arguments: { status: "completed", summary: "Read the project notes." },
				},
			]).reply,
		});
		const opened = open();
		await withDeadline(trace, `${label}: the run that starts the reader`, opened);
		await withDeadline(trace, `${label}: the reader runs`, reported.promise);
		await withDeadline(trace, `${label}: the report wakes C`, woken.promise);
		await sessionC.agent.waitForIdle();
		const origins = completionOrigins();
		expect(origins.length, `${label}: one report is delivered`).toBe(before + 1);
		const started = attemptsOfC().filter((attempt) => !attemptsBefore.has(attempt.attemptId));
		expect(
			started.length,
			`${label}: the run starts one reader attempt: ${JSON.stringify(started.map(({ attemptId, dispatch }) => ({ attemptId, profileId: dispatch.profileId, turnOrigin: dispatch.turnOrigin })))}`,
		).toBe(1);
		return { completion: origins.at(-1), dispatch: started[0]?.dispatch };
	};
	const peerReader = await readerLeg(
		"pi-chat-peer-reader",
		async () =>
			expectStatus(
				await callTool(sessionA, "agent_send", {
					to: meshIdC,
					message: "have a reader look at the notes",
					messageId: "leg-reader-1",
					timeoutMs: TOOL_TIMEOUT_MS,
				}),
				"received",
				"the peer's delegation request is received",
			),
		false,
	);
	expect(peerReader.dispatch?.turnOrigin, "the peer's run hands its origin to the worker it starts").toMatchObject({
		k: "peer-agent",
		channel: "pi-chat",
		thirdParty: true,
	});
	expect(peerReader.completion, "the report of a peer's worker opens a third-party run").toEqual({
		v: 1,
		k: "worker-result",
		thirdParty: true,
	});
	const ownerReader = await readerLeg(
		"pi-chat-owner-reader",
		() => sessionC.prompt("Have a reader look at the notes."),
		true,
	);
	expect(ownerReader.dispatch?.turnOrigin, "the owner's own run hands no origin to its worker").toBeUndefined();
	expect(ownerReader.completion, "the owner's worker's report is the owner's automation").toEqual({
		v: 1,
		k: "worker-result",
	});
	trace.mark("root", "pi-chat.reader-origins");

	// Control: the owner's own turn pushes under the default grant. A peer message arriving during that run is queued as a
	// follow-up: it never joins the owner's run, which keeps its authority, and opens its own run once the owner's ends.
	world.shell.enqueue({ name: "pi-chat-owner-push", command: pushCommand, output: "", exitCode: 0 });
	const ownerRunLive = createBarrier();
	const peerQueued = createBarrier();
	const peerAside = "a peer aside during the owner's run";
	const ownerAnswered = createBarrier();
	world.provider.enqueue(
		"root",
		{
			...calls("pi-chat-owner-push-call", [
				{ id: "pi-chat-owner-push-0", name: "bash", arguments: { command: pushCommand } },
			]),
			// The owner's run is live and held here until the peer's message is queued.
			check: () => ownerRunLive.release(),
			gate: peerQueued.promise,
		},
		{
			name: "pi-chat-owner-push-answer",
			check: (request) => {
				const seen = JSON.stringify(request.context.messages);
				expect(JSON.stringify(request.context.messages.slice(-1)), "the owner's run is not held").not.toContain(
					"Prepared, not run",
				);
				expect(seen, "the peer's message never joins the owner's run").not.toContain(peerAside);
				ownerAnswered.release();
			},
			reply: { content: [{ type: "text", text: "Pushed." }] },
		},
	);
	const asideRun = createBarrier();
	world.provider.enqueue("root", {
		name: "pi-chat-peer-aside-answer",
		check: (request) => {
			expect(JSON.stringify(request.context.messages), "the queued message opens its own run").toContain(peerAside);
			expect(world.shell.reached, "after the owner's run has pushed").toContain("pi-chat-owner-push");
			asideRun.release();
		},
		reply: { content: [{ type: "text", text: "Noted." }] },
	});
	const ownerTurn = sessionC.prompt("Push main.");
	await withDeadline(trace, "C's owner run is live", ownerRunLive.promise);
	expectStatus(
		await callTool(sessionA, "agent_send", {
			to: meshIdC,
			message: peerAside,
			messageId: "leg-aside-1",
			timeoutMs: TOOL_TIMEOUT_MS,
		}),
		"received",
		"a peer message during the owner's run is queued",
	);
	peerQueued.release();
	await withDeadline(trace, "C's owner turn", ownerTurn);
	await withDeadline(trace, "C's owner run pushes", ownerAnswered.promise);
	await withDeadline(trace, "the queued peer message opens its own run", asideRun.promise);
	await sessionC.agent.waitForIdle();
	expect(world.shell.reached, "the owner's run reaches the shell").toContain("pi-chat-owner-push");

	// Control: once the owner grants git.publish themselves (their edge command), a peer's run pushes too.
	sessionC.grantEdge("git.publish", "operator", { note: "the owner's edge command" });
	world.shell.enqueue({ name: "pi-chat-granted-peer-push", command: pushCommand, output: "", exitCode: 0 });
	const grantedPush = pushTurn("pi-chat-granted-peer-push", 1, (results) => {
		expect(results, "a standing grant covers the peer's run").not.toContain("Prepared, not run");
	});
	expectStatus(
		await callTool(sessionA, "agent_send", {
			to: meshIdC,
			message: "push main again",
			messageId: "leg-push-2",
			timeoutMs: TOOL_TIMEOUT_MS,
		}),
		"received",
		"the peer's second push request is received",
	);
	await withDeadline(trace, "C's granted peer run pushes", grantedPush.promise);
	await sessionC.agent.waitForIdle();
	expect(world.shell.reached, "the granted peer run reaches the shell").toContain("pi-chat-granted-peer-push");
	expect(drafts().length, "nothing new is held").toBe(1);
	trace.mark("root", "pi-chat.push-granted");

	// No body outside a held message's inbox file; the audit log keeps metadata only.
	const audit = String(world.io.readFileSync(`${stateRoot}/sessions/local/audit.jsonl`));
	for (const body of ["live hello from A", "held for you", "forged mail"]) {
		expect(audit, `the audit log never holds a body (${body})`).not.toContain(body);
	}

	await dispose(sessionC, "C's disposal");
	await dispose(sessionB, "B's second disposal");
	await dispose(sessionA, "A's disposal");
	trace.mark("root", "pi-chat.disposed");
}
