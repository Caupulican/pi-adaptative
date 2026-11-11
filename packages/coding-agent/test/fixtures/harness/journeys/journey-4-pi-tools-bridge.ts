/**
 * `pi_tools` bridge and worker nested-call journey leg: proves the `python` tool's per-run local channel
 * (`PI_TOOL_BRIDGE` + `PI_TOOL_BRIDGE_TOKEN_FILE` + generated `pi_tools.py` client module), secret-file
 * single-consumption and wrong-token rejection, nested `read` and `edit` execution carrying the parent's exclusive
 * file-mutation hold, unrequested-tool refusal, credential-path mocking on root vs denial on workers, task-scope and
 * confined `readPaths` refusal (including `p/...` path-alias expansion before `admitNested`), `maxToolCalls` cutoff,
 * foreground-only enforcement, delegated worker `lookup` + `pi_tools` execution without `worker_protocol_error`, and
 * clean listener/directory teardown across both System One modes.
 */

import "../builtin-install.ts";
import { connect as connectSocket, type Socket } from "node:net";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { expect } from "vitest";
import {
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationProfile,
} from "../../../../src/core/orchestration/contracts.ts";
import { OrchestrationProfileStore } from "../../../../src/core/orchestration/profile-store.ts";
import type { PythonToolDetails } from "../../../../src/core/tools/schemas/python.ts";
import {
	TOOL_BRIDGE_ADDRESS_ENV,
	TOOL_BRIDGE_CLIENT_MODULE,
	TOOL_BRIDGE_TOKEN_FILE_ENV,
} from "../../../../src/core/tools/tool-bridge-policy.ts";
import { calls, createBarrier, type ScriptedRequest } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, harnessPath, projectPath, withDeadline } from "../session-fixture.ts";
import { dynamicCalls, INTAKE_JUDGMENTS_WITHOUT_GRANT, latestBatchResults } from "./shared.ts";

interface BridgeReplyFrame {
	readonly t?: string;
	readonly id?: number;
	readonly ok?: boolean;
	readonly text?: string;
	readonly kind?: string;
	readonly message?: string;
}

class BridgeWireClient {
	private readonly socket: Socket;
	private readonly lines: ReturnType<typeof createInterface>;
	private readonly pending: Array<(frame: BridgeReplyFrame | null) => void> = [];
	private readonly buffered: Array<BridgeReplyFrame | null> = [];
	private ended = false;

	private constructor(socket: Socket) {
		this.socket = socket;
		this.lines = createInterface({ input: socket });
		this.lines.on("line", (line) => {
			if (!line.trim()) return;
			this.deliver(JSON.parse(line) as BridgeReplyFrame);
		});
		const onEnd = () => {
			if (this.ended) return;
			this.ended = true;
			this.deliver(null);
		};
		socket.once("end", onEnd);
		socket.once("close", onEnd);
		socket.once("error", onEnd);
	}

	static async open(address: string): Promise<BridgeWireClient> {
		const socket = await new Promise<Socket>((resolve, reject) => {
			const client = connectSocket(address);
			const onError = (error: Error) => {
				client.off("connect", onConnect);
				reject(error);
			};
			const onConnect = () => {
				client.off("error", onError);
				resolve(client);
			};
			client.once("error", onError);
			client.once("connect", onConnect);
		});
		return new BridgeWireClient(socket);
	}

	private deliver(frame: BridgeReplyFrame | null): void {
		const waiter = this.pending.shift();
		if (waiter) waiter(frame);
		else this.buffered.push(frame);
	}

	send(frame: Record<string, unknown>): void {
		this.socket.write(`${JSON.stringify(frame)}\n`);
	}

	receive(): Promise<BridgeReplyFrame | null> {
		if (this.buffered.length > 0) return Promise.resolve(this.buffered.shift() ?? null);
		if (this.ended) return Promise.resolve(null);
		return new Promise((resolve) => this.pending.push(resolve));
	}

	async close(): Promise<void> {
		this.lines.close();
		if (this.socket.destroyed) return;
		await new Promise<void>((resolve) => {
			this.socket.once("close", () => resolve());
			this.socket.destroy();
		});
	}
}

function pythonResult(request: ScriptedRequest): {
	isError: boolean;
	text: string;
} {
	const result = latestBatchResults(request).find((entry) => entry.toolName === "python");
	if (!result) throw new Error("expected python tool result in batch");
	return {
		isError: result.isError,
		text: result.text,
	};
}

export async function runJourney4PiToolsBridgePhase(world: HarnessWorld): Promise<void> {
	const { trace } = world;
	const agentDir = `${world.agentDir}-pi-tools-bridge`;
	const targetPath = projectPath("src", "bridge-target.ts");
	const deepTargetDir = projectPath("src", "features", "nested");
	const deepTargetPath = join(deepTargetDir, "bridge-worker-target.ts");
	const envSecretPath = projectPath(".env");
	const outsideSecretDir = harnessPath("outside-scope", "secrets");
	const outsideSecretPath = join(outsideSecretDir, "outside-pi-tools-secret.txt");
	world.io.mkdirSync(deepTargetDir, { recursive: true });
	world.io.mkdirSync(outsideSecretDir, { recursive: true });
	world.io.writeFileSync(targetPath, "export const BRIDGE_COUNT = 1;\n");
	world.io.writeFileSync(deepTargetPath, "export const WORKER_BRIDGE_OK = true;\n");
	world.io.writeFileSync(envSecretPath, "BRIDGE_API_KEY=secret-value-123\n");
	world.io.writeFileSync(outsideSecretPath, "outside task scope\n");

	const BRIDGE_WORKER_PROFILE: OrchestrationProfile = {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		profileId: "bridge-worker",
		description: "Confined worker with read, lookup and python tools.",
		role: "implementer",
		modelPolicy: {
			mode: "fixed",
			candidates: [{ provider: "harness-script", modelId: "worker-a", thinkingLevel: "off" }],
		},
		capabilityCeiling: ["filesystem.read", "process.exec"],
		readOnly: false,
		readPaths: [HARNESS_PROJECT_CWD],
		toolNames: ["read", "lookup", "python"],
		resourceProfileNames: [],
		dispatchProfileIds: [],
		budget: { maxTokens: 50_000 },
		maxConcurrent: 1,
		leaseTtlMs: 60_000,
		requireIndependentVerification: false,
		createdAt: "2026-10-08T00:00:00.000Z",
		updatedAt: "2026-10-08T00:00:00.000Z",
	};
	new OrchestrationProfileStore({
		agentDir,
		cwd: HARNESS_PROJECT_CWD,
		projectTrusted: false,
	}).save(BRIDGE_WORKER_PROFILE, "global");

	const manager = world.createSessionManager(agentDir);
	const { session } = await world.createRootSession("root", {
		agentDir,
		sessionManager: manager,
		omitShellOperations: false,
		extensionFactories: [
			(pi) => {
				pi.on("tool_call", async (event) => {
					if (
						event.toolName === "read" &&
						String((event.input as { path?: unknown }).path ?? "") === outsideSecretPath
					) {
						return { block: true, reason: "outside task scope" };
					}
					return undefined;
				});
			},
		],
		settings: {
			autoLearn: { enabled: false },
			proactivity: { enabled: false },
			orchestrator: { delegationGate: false },
		},
	});
	await session.bindExtensions({ uiContext: world.humanInput.ui });

	let clientDirObserved = "";
	let addressObserved = "";
	let tokenFileModeOk = false;
	let tokenAbsentFromEnv = false;
	let generatedClientCheck = {
		exportsReadAndEdit: false,
		omitsWriteAndBash: false,
		typedReadSignature: false,
		kwargsEditSignature: false,
	};
	let wrongTokenRejected = false;
	const wireReplies: BridgeReplyFrame[] = [];

	const snippetCode = [
		"import pi_tools",
		'text = pi_tools.read("src/bridge-target.ts")',
		'pi_tools.edit(path="src/bridge-target.ts", edits=[{"oldText": "BRIDGE_COUNT = 1", "newText": "BRIDGE_COUNT = 2"}])',
		'print("bridged edit complete")',
	].join("\n");

	world.windowsShell.enqueuePythonToolRun("j4-pi-tools-run", async (invocation) => {
		expect(invocation.cwd).toBe(HARNESS_PROJECT_CWD);
		expect(invocation.stdin).toBe(snippetCode);

		const pythonPath = invocation.env.PYTHONPATH ?? "";
		clientDirObserved = pythonPath.split(delimiter)[0] ?? "";
		const modulePath = join(clientDirObserved, `${TOOL_BRIDGE_CLIENT_MODULE}.py`);
		const moduleSource = String(world.io.readFileSync(modulePath, "utf8"));
		generatedClientCheck = {
			exportsReadAndEdit: moduleSource.includes('"read"') && moduleSource.includes('"edit"'),
			omitsWriteAndBash: !moduleSource.includes("def write(") && !moduleSource.includes("def bash("),
			typedReadSignature: moduleSource.includes("def read(path,"),
			kwargsEditSignature: moduleSource.includes("def edit(**args):"),
		};

		const tokenFile = invocation.env[TOOL_BRIDGE_TOKEN_FILE_ENV] ?? "";
		addressObserved = invocation.env[TOOL_BRIDGE_ADDRESS_ENV] ?? "";
		if (process.platform !== "win32") {
			tokenFileModeOk = (Number(world.io.statSync(tokenFile).mode) & 0o777) === 0o600;
		} else {
			tokenFileModeOk = world.io.existsSync(tokenFile);
		}
		const secret = String(world.io.readFileSync(tokenFile, "utf8"));
		// Exactly as pi_tools._take_secret() does at import: remove the one-time token file immediately.
		world.io.unlinkSync(tokenFile);
		tokenAbsentFromEnv = !Object.values(invocation.env).some((value) => value === secret);

		// 1. Unauthenticated / wrong-token connection is rejected and counted in authFailures.
		const unauth = await BridgeWireClient.open(addressObserved);
		try {
			unauth.send({ t: "hello", token: "0".repeat(64) });
			const reply = await unauth.receive();
			wrongTokenRejected = reply === null;
		} finally {
			await unauth.close();
		}

		// 2. Authenticated channel exercises allowed calls, nested mutation carry, policy/credential/scope refusals, and call limit.
		const channel = await BridgeWireClient.open(addressObserved);
		try {
			channel.send({ t: "hello", token: secret });
			const ready = await channel.receive();
			expect(ready).toEqual({ t: "ready" });

			const requests: Array<{ id: number; tool: string; args: Record<string, unknown> }> = [
				{ id: 1, tool: "read", args: { path: "src/bridge-target.ts" } },
				{
					id: 2,
					tool: "edit",
					args: {
						path: "src/bridge-target.ts",
						edits: [{ oldText: "BRIDGE_COUNT = 1", newText: "BRIDGE_COUNT = 2" }],
					},
				},
				{ id: 3, tool: "write", args: { path: "src/bridge-target.ts", content: "overwritten\n" } },
				{ id: 4, tool: "read", args: { path: ".env" } },
				{ id: 5, tool: "read", args: { path: outsideSecretPath } },
				{ id: 6, tool: "read", args: { path: "src/bridge-target.ts" } },
			];
			for (const req of requests) {
				channel.send({ t: "call", id: req.id, tool: req.tool, args: req.args });
				const reply = await channel.receive();
				if (reply === null) throw new Error(`channel closed unexpectedly on call ${req.id}`);
				wireReplies.push(reply);
			}
		} finally {
			await channel.close();
		}

		return { exitCode: 0, stdout: "bridged edit complete\n" };
	});

	let backgroundRejected: { isError: boolean; text: string } | undefined;
	let bridgedOutcome: { isError: boolean; text: string } | undefined;
	let workerLookupOutcome: { isError: boolean; text: string } | undefined;
	let workerPythonOutcome: { isError: boolean; text: string } | undefined;
	const workerWireReplies: BridgeReplyFrame[] = [];
	let workerDeepAlias = "";
	let workerOutsideAlias = "";
	let workerHandoffDelivered = false;
	const settled = createBarrier();

	const workerSnippetCode = ["import pi_tools", 'print("worker pi_tools complete")'].join("\n");

	world.windowsShell.enqueuePythonToolRun("j4-worker-pi-tools", async (invocation) => {
		expect(invocation.cwd).toBe(HARNESS_PROJECT_CWD);
		expect(invocation.stdin).toBe(workerSnippetCode);

		const tokenFile = invocation.env[TOOL_BRIDGE_TOKEN_FILE_ENV] ?? "";
		const workerAddress = invocation.env[TOOL_BRIDGE_ADDRESS_ENV] ?? "";
		const secret = String(world.io.readFileSync(tokenFile, "utf8"));
		world.io.unlinkSync(tokenFile);

		const channel = await BridgeWireClient.open(workerAddress);
		try {
			channel.send({ t: "hello", token: secret });
			const ready = await channel.receive();
			expect(ready).toEqual({ t: "ready" });

			const requests: Array<{ id: number; tool: string; args: Record<string, unknown> }> = [
				{ id: 1, tool: "read", args: { path: workerDeepAlias } },
				{ id: 2, tool: "read", args: { path: ".env" } },
				{ id: 3, tool: "read", args: { path: workerOutsideAlias } },
				{
					id: 4,
					tool: "edit",
					args: {
						path: "src/bridge-target.ts",
						edits: [{ oldText: "BRIDGE_COUNT = 2", newText: "BRIDGE_COUNT = 9" }],
					},
				},
			];
			for (const req of requests) {
				channel.send({ t: "call", id: req.id, tool: req.tool, args: req.args });
				const reply = await channel.receive();
				if (reply === null) throw new Error(`worker channel closed unexpectedly on call ${req.id}`);
				workerWireReplies.push(reply);
			}
		} finally {
			await channel.close();
		}

		return { exitCode: 0, stdout: "worker pi_tools complete\n" };
	});

	world.provider.enqueue(
		"worker-a",
		dynamicCalls("j4-worker-lookup-step", () => {
			const entries = session.peekPathAliasTable().entries;
			const deep = entries.find((entry) => entry.id.endsWith("bridge-worker-target.ts"))?.id;
			const outside = entries.find((entry) => entry.id.endsWith("outside-pi-tools-secret.txt"))?.id;
			if (!deep || !outside) {
				throw new Error(
					`expected path aliases for worker bridge targets, got ${JSON.stringify(entries.map((entry) => entry.id))}`,
				);
			}
			workerDeepAlias = deep;
			workerOutsideAlias = outside;
			return [
				{
					id: "j4-worker-lookup",
					name: "lookup",
					arguments: {
						requests: [
							{ read: { path: workerDeepAlias } },
							{ read: { path: ".env" } },
							{ read: { path: workerOutsideAlias } },
						],
					},
				},
			];
		}),
		{
			...calls("j4-worker-pi-tools-step", [
				{
					id: "j4-worker-pi-tools",
					name: "python",
					arguments: {
						code: workerSnippetCode,
						tools: ["read"],
					},
				},
			]),
			check: (request) => {
				const lookup = latestBatchResults(request).find((entry) => entry.toolName === "lookup");
				if (!lookup) throw new Error("expected lookup tool result in worker batch");
				workerLookupOutcome = { isError: lookup.isError, text: lookup.text };
			},
		},
		{
			...calls("j4-worker-report-step", [
				{
					id: "j4-worker-report",
					name: "submit_report",
					arguments: {
						status: "completed",
						summary: "Worker nested lookup and pi_tools bridge run complete.",
					},
				},
			]),
			check: (request) => {
				workerPythonOutcome = pythonResult(request);
			},
		},
	);

	world.provider.enqueue(
		"root",
		calls("j4-pi-tools-bg-call", [
			{
				id: "j4-pi-tools-bg",
				name: "python",
				arguments: {
					code: "import pi_tools\n",
					tools: ["read"],
					background: true,
				},
			},
		]),
		{
			...calls("j4-pi-tools-run-call", [
				{
					id: "j4-pi-tools-run",
					name: "python",
					arguments: {
						code: snippetCode,
						tools: ["read", "edit"],
						maxToolCalls: 5,
					},
				},
			]),
			check: (request) => {
				const bg = pythonResult(request);
				backgroundRejected = { isError: bg.isError, text: bg.text };
			},
		},
		{
			...calls("j4-pi-tools-delegate-call", [
				{
					id: "j4-pi-tools-delegate",
					name: "delegate",
					arguments: {
						action: "start",
						profileId: "bridge-worker",
						instructions: `Inspect ${deepTargetPath} and ${outsideSecretPath} with lookup and python.`,
					},
				},
			]),
			check: (request) => {
				bridgedOutcome = pythonResult(request);
			},
		},
		{
			name: "j4-pi-tools-delegated",
			check: (request) => {
				const started = latestBatchResults(request).find((entry) => entry.toolName === "delegate");
				if (started?.isError || !started?.text.includes("delegate started")) {
					throw new Error(`the bridge worker did not start: ${started?.text ?? "no result"}`);
				}
			},
			reply: { content: [{ type: "text", text: "pi_tools run finished." }] },
		},
		{
			name: "j4-pi-tools-worker-wake",
			maxRequests: 8,
			until: (request) => {
				const messagesText = JSON.stringify(request.context.messages);
				const done =
					messagesText.includes("Background worker terminal handoff") &&
					messagesText.includes("Worker nested lookup and pi_tools bridge run complete.");
				if (done) {
					workerHandoffDelivered = true;
					settled.release();
				}
				return done;
			},
			reply: { content: [{ type: "text", text: "Worker report noted." }] },
		},
	);

	world.systemOne.enterPhase("j4-pi-tools-bridge", INTAKE_JUDGMENTS_WITHOUT_GRANT);

	await withDeadline(
		trace,
		"the pi_tools bridge turn",
		session.prompt(
			`Use python with pi_tools on src/bridge-target.ts, then delegate ${deepTargetPath} and ${outsideSecretPath}.`,
		),
	);
	await withDeadline(trace, "the pi_tools bridge and worker handoff complete", settled.promise, 90_000);
	await withDeadline(trace, "the pi_tools session is at rest", session.waitForForegroundIdle());

	const bridgedEntry = manager
		.getBranch()
		.find(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolCallId === "j4-pi-tools-run",
		);
	const persistedDetails =
		bridgedEntry?.type === "message" && bridgedEntry.message.role === "toolResult"
			? (bridgedEntry.message.details as PythonToolDetails | undefined)
			: undefined;
	const bridgeReport = persistedDetails?.toolBridge;

	expect(
		{
			backgroundError: backgroundRejected?.isError,
			backgroundMessage: backgroundRejected?.text.includes(
				"A script with tools runs in the foreground; drop background.",
			),
			generatedClientCheck,
			tokenFileModeOk,
			tokenAbsentFromEnv,
			wrongTokenRejected,
			bridgedError: bridgedOutcome?.isError,
			bridgedStdout: bridgedOutcome?.text.includes("bridged edit complete"),
			bridgedTraceBanner: bridgedOutcome?.text.includes("[pi_tools: 6 calls"),
			bridgedAuthFailures: bridgedOutcome?.text.includes("1 connection(s) refused for a wrong secret"),
			report: bridgeReport
				? {
						tools: bridgeReport.tools,
						calls: bridgeReport.calls,
						byTool: bridgeReport.byTool,
						authFailures: bridgeReport.authFailures as unknown,
						outcomes: bridgeReport.outcomes,
					}
				: undefined,
			replies: wireReplies.map((reply) => ({
				id: reply.id,
				ok: reply.ok,
				kind: reply.kind,
				isReadBaseline: reply.ok
					? Boolean(reply.text?.includes("BRIDGE_COUNT = 1") && !reply.text.includes("Successfully replaced"))
					: undefined,
				isEditSuccess: reply.ok ? Boolean(reply.text?.includes("Successfully replaced 1 block(s)")) : undefined,
				isEnvMocked: reply.ok
					? Boolean(reply.text?.includes("BRIDGE_API_KEY=") && !reply.text.includes("secret-value-123"))
					: undefined,
				notInToolsList: !reply.ok
					? Boolean(reply.message?.includes("write is not in this run's tools list"))
					: undefined,
				isScopeRefused: !reply.ok ? Boolean(reply.message?.includes("outside task scope")) : undefined,
			})),
			updatedFile: String(world.io.readFileSync(targetPath, "utf8")),
			tempDirCleaned: clientDirObserved !== "" && !world.io.existsSync(clientDirObserved),
			socketCleaned:
				addressObserved !== "" &&
				(addressObserved.startsWith("\\\\.\\pipe\\") || !world.io.existsSync(addressObserved)),
		},
		"pi_tools generates scoped bindings, isolates the one-time secret, admits nested read/edit calls under session gates, mocks .env credentials, refuses unrequested/out-of-scope/over-limit calls, and cleans up",
	).toEqual({
		backgroundError: true,
		backgroundMessage: true,
		generatedClientCheck: {
			exportsReadAndEdit: true,
			omitsWriteAndBash: true,
			typedReadSignature: true,
			kwargsEditSignature: true,
		},
		tokenFileModeOk: true,
		tokenAbsentFromEnv: true,
		wrongTokenRejected: true,
		bridgedError: false,
		bridgedStdout: true,
		bridgedTraceBanner: true,
		bridgedAuthFailures: true,
		report: {
			tools: ["read", "edit"],
			calls: 6,
			byTool: {
				read: 4,
				edit: 1,
				other: 1,
			},
			authFailures: "<mocked:authFailures>",
			outcomes: {
				ok: 3,
				refused: 2,
				error: 0,
				limit: 1,
				cancelled: 0,
			},
		},
		replies: [
			{
				id: 1,
				ok: true,
				kind: undefined,
				isReadBaseline: true,
				isEditSuccess: false,
				isEnvMocked: false,
				notInToolsList: undefined,
				isScopeRefused: undefined,
			},
			{
				id: 2,
				ok: true,
				kind: undefined,
				isReadBaseline: false,
				isEditSuccess: true,
				isEnvMocked: false,
				notInToolsList: undefined,
				isScopeRefused: undefined,
			},
			{
				id: 3,
				ok: false,
				kind: "refused",
				isReadBaseline: undefined,
				isEditSuccess: undefined,
				isEnvMocked: undefined,
				notInToolsList: true,
				isScopeRefused: false,
			},
			{
				id: 4,
				ok: true,
				kind: undefined,
				isReadBaseline: false,
				isEditSuccess: false,
				isEnvMocked: true,
				notInToolsList: undefined,
				isScopeRefused: undefined,
			},
			{
				id: 5,
				ok: false,
				kind: "refused",
				isReadBaseline: undefined,
				isEditSuccess: undefined,
				isEnvMocked: undefined,
				notInToolsList: false,
				isScopeRefused: true,
			},
			{
				id: 6,
				ok: false,
				kind: "limit",
				isReadBaseline: undefined,
				isEditSuccess: undefined,
				isEnvMocked: undefined,
				notInToolsList: false,
				isScopeRefused: false,
			},
		],
		updatedFile: "export const BRIDGE_COUNT = 2;\n",
		tempDirCleaned: true,
		socketCleaned: true,
	});

	const lookupText = workerLookupOutcome?.text ?? "";
	expect(
		{
			workerHandoffDelivered,
			aliasesUsed: workerDeepAlias.startsWith("p/") && workerOutsideAlias.startsWith("p/"),
			lookupError: workerLookupOutcome?.isError,
			lookupReadsDeepTarget: lookupText.includes("WORKER_BRIDGE_OK = true"),
			lookupHidesSecrets: !lookupText.includes("secret-value-123") && !lookupText.includes("outside task scope"),
			lookupRefusalCount: (lookupText.match(/\nrefused: /g) ?? []).length,
			workerPythonError: workerPythonOutcome?.isError,
			workerPythonStdout: workerPythonOutcome?.text.includes("worker pi_tools complete"),
			workerPythonBanner: workerPythonOutcome?.text.includes(
				"[pi_tools: 4 calls (3 read, 1 other): 1 ok, 3 refused;",
			),
			workerReplies: workerWireReplies.map((reply) => ({
				id: reply.id,
				ok: reply.ok,
				kind: reply.kind,
				readsDeepTarget: reply.ok ? Boolean(reply.text?.includes("WORKER_BRIDGE_OK = true")) : undefined,
				leaksSecret: Boolean(
					reply.text?.includes("secret-value-123") ||
						reply.text?.includes("outside task scope") ||
						reply.message?.includes("secret-value-123") ||
						reply.message?.includes("outside task scope"),
				),
			})),
		},
		"delegated worker runs nested lookup and pi_tools sub-calls without worker_protocol_error, expanding p/... aliases before admitNested while denying .env and out-of-readPaths targets",
	).toEqual({
		workerHandoffDelivered: true,
		aliasesUsed: true,
		lookupError: false,
		lookupReadsDeepTarget: true,
		lookupHidesSecrets: true,
		lookupRefusalCount: 2,
		workerPythonError: false,
		workerPythonStdout: true,
		workerPythonBanner: true,
		workerReplies: [
			{ id: 1, ok: true, kind: undefined, readsDeepTarget: true, leaksSecret: false },
			{ id: 2, ok: false, kind: "refused", readsDeepTarget: undefined, leaksSecret: false },
			{ id: 3, ok: false, kind: "refused", readsDeepTarget: undefined, leaksSecret: false },
			{ id: 4, ok: false, kind: "refused", readsDeepTarget: undefined, leaksSecret: false },
		],
	});

	expect(await world.disposeSessionInBody(session), "the pi_tools bridge session closes").toBeUndefined();
	trace.mark("root", "pi-tools-bridge.closed");
}
