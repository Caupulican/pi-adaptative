import { join } from "node:path";
import { expect } from "vitest";
import { getBundledResourcesDir } from "../../../../src/config.ts";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { piChatExtension } from "../../../../src/core/chat/extension.ts";
import { sessionMeshId } from "../../../../src/core/chat/identity.ts";
import type { AgentSendResult } from "../../../../src/core/chat/mesh.ts";
import { MessageInbox } from "../../../../src/core/messaging/inbox.ts";
import type { SessionManager } from "../../../../src/kernel/session/session-manager.ts";
import { createBarrier } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";

const TOOL_TIMEOUT_MS = 10_000;

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

function targetStatus(details: unknown): string | undefined {
	return (details as AgentSendResult).targets[0]?.status;
}

/**
 * pi-chat addresses the pi session and holds mail for a peer that is away. Two root sessions join one mesh over the world's
 * in-memory network: a live message reaches the peer (the control); the peer's session ends and is resumed under the same
 * session id; a message sent while it is away is held in its inbox, reported as queued and, sent again with its messageId,
 * as queued still; the resumed session re-claims its id with the credential it kept and takes the held message once,
 * with the sender's standing attested; a later send of the same messageId is acknowledged without a second turn; mail
 * forged into the inbox arrives as an unverified peer; and no message body is stored once its message is settled or
 * written to the audit log.
 */
export async function runJourney1PiChatPhase(world: HarnessWorld): Promise<void> {
	const { trace } = world;
	const stateRoot = `${world.agentDir}-pi-chat-state`;
	const agentDirA = `${world.agentDir}-pi-chat-a`;
	const agentDirB = `${world.agentDir}-pi-chat-b`;
	const managerA = world.createSessionManager(agentDirA);
	const managerB = world.createSessionManager(agentDirB);
	const settings = { memorySystem: "okf", autoLearn: { enabled: false } } as const;
	const open = async (manager: SessionManager, agentDir: string): Promise<AgentSession> => {
		const created = await world.createRootSession("root", {
			agentDir,
			sessionManager: manager,
			settings,
			extensionFactories: [(pi) => piChatExtension(pi, { stateRoot })],
		});
		await created.session.bindExtensions({ uiContext: world.humanInput.ui });
		return created.session;
	};
	const dispose = async (session: AgentSession, label: string): Promise<void> => {
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
	expect(targetStatus(live.details), "a live message is received, not queued").toBe("received");
	await withDeadline(trace, "B takes the live message", liveTurn.promise);
	await sessionB.agent.waitForIdle();
	expect(taken.at(-1), "B's turn carries the live message").toContain("live hello from A");
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
	expect(targetStatus(held.details), "a message to an absent peer is queued").toBe("queued");
	const again = await callTool(sessionA, "agent_send", {
		to: meshIdB,
		message: "held for you",
		messageId: "leg-held-1",
		timeoutMs: TOOL_TIMEOUT_MS,
	});
	expect(targetStatus(again.details), "sending again reports the fate: still queued").toBe("queued");
	const changed = await callTool(sessionA, "agent_send", {
		to: meshIdB,
		message: "a different message under the same id",
		messageId: "leg-held-1",
		timeoutMs: TOOL_TIMEOUT_MS,
	});
	expect(targetStatus(changed.details), "an id reused for another message is refused").toBe("failed");
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
	expect(targetStatus(repeated.details), "a repeated send is received without a second delivery").toBe("received");

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

	// No body outside a held message's inbox file; the audit log keeps metadata only.
	const audit = String(world.io.readFileSync(`${stateRoot}/sessions/local/audit.jsonl`));
	for (const body of ["live hello from A", "held for you", "forged mail"]) {
		expect(audit, `the audit log never holds a body (${body})`).not.toContain(body);
	}

	await dispose(sessionB, "B's second disposal");
	await dispose(sessionA, "A's disposal");
	trace.mark("root", "pi-chat.disposed");
}
