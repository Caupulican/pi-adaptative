import "../builtin-install.ts";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { PI_SESSION_ROLE_ENV } from "../../../../src/core/session-role.ts";
import { routeShellContract } from "../../../../src/core/tools/shell-contract-router.ts";
import { getWorkRoot, getWorkTenantDir } from "../../../../src/utils/work-directory.ts";
import { calls, type ScriptedRequest } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { dynamicCalls, ICM_INTAKE_JUDGMENTS, NO_DELIVERY_CLAIMS, refusalDiagnostic } from "./shared.ts";

const { optional_tool_0: _workerNoOptionalTool, ...WORKER_INTAKE_JUDGMENTS } = ICM_INTAKE_JUDGMENTS;

const OPERATION_PROCEED_JUDGMENTS = {
	leaves_machine: { kind: "noul", probability: 0.02 },
	cannot_be_undone: { kind: "noul", probability: 0.02 },
	touches_outside_task: { kind: "noul", probability: 0.02 },
	acquires_external_code: { kind: "noul", probability: 0.02 },
	request_authorizes: { kind: "noul", probability: 0.02 },
} as const;

const SPILL_COMMAND = "echo l6-spill";
const SPILL_LINE_COUNT = 2_200;

function batchResultById(request: ScriptedRequest, toolCallId: string): { isError: boolean; text: string } | undefined {
	const messages = request.context.messages;
	let start = messages.length;
	while (start > 0 && messages[start - 1]?.role !== "assistant") start--;
	for (const message of messages.slice(start)) {
		if (message.role !== "toolResult" || message.toolCallId !== toolCallId) continue;
		const text = message.content.map((block) => (block.type === "text" ? block.text : block.type)).join("\n");
		return { isError: message.isError, text };
	}
	return undefined;
}

/**
 * Worker `tool-streams` isolation: each worker session acquires its own `outputs/tool-streams/run-*` directory under
 * `<agentDir>/work`. When `OutputAccumulator` spills oversized tool output into Session A's run directory, Session A's
 * `read` tool can read its own spilled file, cannot `write` or `edit` inside its own `tool-streams` run directory,
 * cannot `read` Session B's sibling `tool-streams` run directory or the `<agentDir>/work` parent directory, and cannot
 * `read` never-exempt secret filenames (`.env`) inside its own `tool-streams` run directory.
 */
export async function runJourney1WorkerToolStreamsPhase(world: HarnessWorld): Promise<void> {
	const { trace } = world;
	const agentDir = `${world.agentDir}-worker-streams`;
	const tenantDir = getWorkTenantDir(agentDir, "outputs", "tool-streams");
	const workRoot = getWorkRoot(agentDir);
	const warningMark = world.warnings.length;
	const previousRole = process.env[PI_SESSION_ROLE_ENV];
	const workerSettings = {
		memorySystem: "okf" as const,
		autoLearn: { enabled: false },
		proactivity: { enabled: false },
	};

	let sessionA: Awaited<ReturnType<HarnessWorld["createRootSession"]>>["session"] | undefined;
	let sessionB: Awaited<ReturnType<HarnessWorld["createRootSession"]>>["session"] | undefined;
	let runADir = "";
	let runBDir = "";

	process.env[PI_SESSION_ROLE_ENV] = "worker";
	try {
		const createdA = await world.createRootSession("worker-a", {
			agentDir,
			sessionManager: world.createSessionManager(agentDir),
			omitShellOperations: false,
			settings: workerSettings,
		});
		sessionA = createdA.session;
		const runsAfterA = readdirSync(tenantDir).filter((entry) => entry.startsWith("run-"));
		expect(runsAfterA, "Session A acquires one tool-streams run directory").toHaveLength(1);
		const runAName = runsAfterA[0]!;
		runADir = join(tenantDir, runAName);

		const createdB = await world.createRootSession("worker-b", {
			agentDir,
			sessionManager: world.createSessionManager(agentDir),
			omitShellOperations: false,
			settings: workerSettings,
		});
		sessionB = createdB.session;
		const runsAfterB = readdirSync(tenantDir).filter((entry) => entry.startsWith("run-"));
		expect(runsAfterB, "Session B acquires a distinct sibling tool-streams run directory").toHaveLength(2);
		const runBName = runsAfterB.find((entry) => entry !== runAName);
		expect(runBName).toBeDefined();
		runBDir = join(tenantDir, runBName!);
		expect(runBDir).not.toBe(runADir);

		const siblingFile = join(runBDir, "sibling-spill.log");
		const dotEnvFile = join(runADir, ".env");
		const forgedWriteFile = join(runADir, "forged.log");
		world.io.seed(siblingFile, "SIBLING_STREAM_PAYLOAD=private-b\n");
		world.io.seed(dotEnvFile, "STREAM_SECRET=never-exempt-secret\n");

		const spilledLines = Array.from(
			{ length: SPILL_LINE_COUNT },
			(_, index) =>
				`l6-spill-line-${String(index + 1).padStart(4, "0")}: ${"stream-payload-segment-".repeat(2)}${index + 1}`,
		).join("\n");
		const routedSpill = routeShellContract(SPILL_COMMAND, process.platform, { pythonEngine: false });
		if (routedSpill.kind === "unsupported") throw new Error(routedSpill.error);
		world.shell.enqueue({
			name: "l6-spill-bash",
			command: routedSpill.command,
			cwd: HARNESS_PROJECT_CWD,
			output: `${spilledLines}\n`,
			exitCode: 0,
		});

		let spilledFilePath = "";
		let probeOutcomes:
			| {
					readOwn: { isError: boolean; text: string } | undefined;
					writeOwn: { isError: boolean; text: string } | undefined;
					editOwn: { isError: boolean; text: string } | undefined;
					readSibling: { isError: boolean; text: string } | undefined;
					readWorkRoot: { isError: boolean; text: string } | undefined;
					readDotEnv: { isError: boolean; text: string } | undefined;
			  }
			| undefined;

		world.provider.enqueue(
			"worker-a",
			calls("l6-bash-spill", [
				{
					id: "l6-bash-1",
					name: "bash",
					arguments: { command: SPILL_COMMAND, fullOutput: true },
				},
			]),
			dynamicCalls(
				"l6-isolation-probes",
				() => {
					const spilledNames = readdirSync(runADir).filter(
						(entry) => entry.startsWith("pi-bash-") && entry.endsWith(".log"),
					);
					if (spilledNames.length !== 1) {
						throw new Error(`expected 1 spilled bash log in ${runADir}, found ${JSON.stringify(spilledNames)}`);
					}
					spilledFilePath = join(runADir, spilledNames[0]!);
					return [
						{
							id: "l6-read-own",
							name: "read",
							arguments: { path: spilledFilePath, offset: 1, limit: 5 },
						},
						{
							id: "l6-write-own",
							name: "write",
							arguments: { path: forgedWriteFile, content: "forged write\n" },
						},
						{
							id: "l6-edit-own",
							name: "edit",
							arguments: {
								path: spilledFilePath,
								edits: [{ oldText: "l6-spill-line-0001", newText: "l6-tampered-line-0001" }],
							},
						},
						{
							id: "l6-read-sibling",
							name: "read",
							arguments: { path: siblingFile },
						},
						{
							id: "l6-read-work-root",
							name: "read",
							arguments: { path: workRoot },
						},
						{
							id: "l6-read-dotenv",
							name: "read",
							arguments: { path: dotEnvFile },
						},
					];
				},
				(request) => {
					const bashResult = batchResultById(request, "l6-bash-1");
					if (!bashResult || bashResult.isError || !bashResult.text.includes("Full output:")) {
						throw new Error(`bash spill did not persist full output: ${bashResult?.text ?? "missing"}`);
					}
				},
			),
			{
				name: "l6-isolation-verified",
				check: (request) => {
					probeOutcomes = {
						readOwn: batchResultById(request, "l6-read-own"),
						writeOwn: batchResultById(request, "l6-write-own"),
						editOwn: batchResultById(request, "l6-edit-own"),
						readSibling: batchResultById(request, "l6-read-sibling"),
						readWorkRoot: batchResultById(request, "l6-read-work-root"),
						readDotEnv: batchResultById(request, "l6-read-dotenv"),
					};
				},
				reply: { content: [{ type: "text", text: "Verified worker tool-streams boundaries." }] },
			},
		);

		world.systemOne.enterPhase("l6-worker-tool-streams", {
			...WORKER_INTAKE_JUDGMENTS,
			...OPERATION_PROCEED_JUDGMENTS,
			...NO_DELIVERY_CLAIMS,
		});
		await withDeadline(
			trace,
			"worker tool-streams isolation turn",
			sessionA.prompt("Run the spill command and verify read and write isolation on tool-streams."),
		);

		expect(spilledFilePath.startsWith(runADir), "OutputAccumulator spilled into Session A's own run dir").toBe(true);
		expect(probeOutcomes).toBeDefined();

		// 1. Session A CAN read its own spilled output file, recovering head lines truncated from the tail preview.
		expect(probeOutcomes?.readOwn?.isError, `readOwn failed: ${probeOutcomes?.readOwn?.text}`).toBe(false);
		expect(probeOutcomes?.readOwn?.text).toContain("l6-spill-line-0001:");
		expect(probeOutcomes?.readOwn?.text).toContain("l6-spill-line-0005:");

		// 2. Session A CANNOT write or edit inside its own tool-streams run directory.
		expect(probeOutcomes?.writeOwn?.isError).toBe(true);
		expect(refusalDiagnostic(probeOutcomes?.writeOwn?.text ?? "") ?? probeOutcomes?.writeOwn?.text).toMatch(
			/outside.*allowed|denied|private/iu,
		);
		expect(world.io.peekFile(forgedWriteFile), "refused write creates no file in runADir").toBeUndefined();

		expect(probeOutcomes?.editOwn?.isError).toBe(true);
		expect(refusalDiagnostic(probeOutcomes?.editOwn?.text ?? "") ?? probeOutcomes?.editOwn?.text).toMatch(
			/outside.*allowed|denied|private/iu,
		);
		expect(world.io.peekFile(spilledFilePath)?.startsWith("l6-spill-line-0001:"), "spilled file is untouched").toBe(
			true,
		);

		// 3. Session A CANNOT read Session B's sibling tool-streams directory or the <agentDir>/work parent directory.
		expect(probeOutcomes?.readSibling?.isError).toBe(true);
		expect(probeOutcomes?.readSibling?.text).not.toContain("SIBLING_STREAM_PAYLOAD");
		expect(probeOutcomes?.readSibling?.text).not.toContain("private-b");

		expect(probeOutcomes?.readWorkRoot?.isError).toBe(true);
		expect(probeOutcomes?.readWorkRoot?.text).not.toContain(runBName!);

		// 4. Session A CANNOT read never-exempt secret filenames (.env) even inside its own tool-streams run directory.
		expect(probeOutcomes?.readDotEnv?.isError).toBe(true);
		expect(probeOutcomes?.readDotEnv?.text).not.toContain("never-exempt-secret");
		expect(probeOutcomes?.readDotEnv?.text).toMatch(/credential|model-blind|denied/iu);

		expect(await world.disposeSessionInBody(sessionA), "Session A disposes cleanly").toBeUndefined();
		sessionA = undefined;
		expect(await world.disposeSessionInBody(sessionB), "Session B disposes cleanly").toBeUndefined();
		sessionB = undefined;

		expect(existsSync(runADir), "Session A disposal releases its tool-streams run directory").toBe(false);
		expect(existsSync(runBDir), "Session B disposal releases its tool-streams run directory").toBe(false);
	} finally {
		if (previousRole === undefined) delete process.env[PI_SESSION_ROLE_ENV];
		else process.env[PI_SESSION_ROLE_ENV] = previousRole;
		if (sessionA) await world.disposeSessionInBody(sessionA);
		if (sessionB) await world.disposeSessionInBody(sessionB);
	}

	expect(world.warnings.slice(warningMark), "worker tool-streams emits no unexpected warnings").toEqual([]);
	trace.mark("root", "worker.tool-streams.done");
}
