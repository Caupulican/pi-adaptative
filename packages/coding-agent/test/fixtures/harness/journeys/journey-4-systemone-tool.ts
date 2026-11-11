/**
 * System One tool journey leg: status, evaluate with referenced file evidence, review (accepted and rejected verdicts),
 * TypeSafe Vision (image preparation, companion presence gating, upright-source-pixel box projection, and credential-path
 * refusal), retained evidence readback, and ripgrep-backed file location across both System One modes.
 */

import "../builtin-install.ts";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { expect } from "vitest";
import { typeSafeEvidenceDir } from "../../../../src/core/agent-paths.ts";
import { getManagedToolBinaryPath } from "../../../../src/utils/tools-manager.ts";
import { calls, createBarrier, type ScriptedRequest } from "../scripted-provider.ts";
import { type HarnessWorld, projectPath, withDeadline } from "../session-fixture.ts";
import { ICM_INTAKE_JUDGMENTS, latestBatchResults, refusalDiagnostic } from "./shared.ts";

const STATE = "The retry limit in src/limits.ts is 3.";
/** The intake judgments a plain prompt consumes here: a start without a profile asks no capability question. */
const { capabilities_authorized: _capabilities, ...INTAKE_JUDGMENTS } = ICM_INTAKE_JUDGMENTS;

function pngChunk(type: string, payload: Buffer): Buffer {
	const typeBytes = Buffer.from(type, "ascii");
	const length = Buffer.alloc(4);
	length.writeUInt32BE(payload.length, 0);
	const crcInput = Buffer.concat([typeBytes, payload]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(crcInput) >>> 0, 0);
	return Buffer.concat([length, typeBytes, payload, crc]);
}

/** Deterministic RGB PNG with no external fixture dependency. */
function makeRgbPng(width: number, height: number): Buffer {
	const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // 8-bit
	ihdr[9] = 2; // RGB
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;
	const rowBytes = 1 + width * 3;
	const raw = Buffer.alloc(height * rowBytes);
	for (let y = 0; y < height; y++) {
		const rowOffset = y * rowBytes;
		raw[rowOffset] = 0;
		for (let x = 0; x < width; x++) {
			const pixel = rowOffset + 1 + x * 3;
			raw[pixel] = (x * 5) & 0xff;
			raw[pixel + 1] = (y * 7) & 0xff;
			raw[pixel + 2] = 0x9c;
		}
	}
	return Buffer.concat([
		signature,
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", deflateSync(raw)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

function rgMatchLine(path: string, lineNumber: number, text: string): string {
	return JSON.stringify({
		type: "match",
		data: {
			path: { text: path },
			lines: { text },
			line_number: lineNumber,
		},
	});
}

/** The result of the `systemone` call a request answers. */
function toolResult(request: ScriptedRequest): { isError: boolean; text: string } {
	const result = latestBatchResults(request).find((entry) => entry.toolName === "systemone");
	if (!result) throw new Error("the request carries no systemone result");
	return { isError: result.isError, text: result.text };
}

export async function runJourney4SystemOneToolPhase(world: HarnessWorld): Promise<void> {
	const { trace } = world;
	const agentDir = `${world.agentDir}-systemone-tool`;
	const uiImagePath = projectPath("ui-screen.png");
	const notesSourcePath = projectPath("src", "notes.ts");
	const envSecretPath = projectPath("src", ".env");
	world.io.writeFileSync(uiImagePath, makeRgbPng(300, 240));
	world.io.writeFileSync(
		notesSourcePath,
		"// Mentions MAX_RETRIES without owning it.\nexport const NOTE_LABEL = 'retries';\n",
	);
	world.io.writeFileSync(envSecretPath, "API_TOKEN=MAX_RETRIES_SECRET\n");

	const rgPath = getManagedToolBinaryPath("rg");
	world.io.seed(rgPath, "virtual managed rg\n");
	let rgDrained: Promise<void> | undefined;
	if (world.systemOne.enabled) {
		rgDrained = world.processes.scriptServiceManager([
			{
				file: rgPath,
				args: [
					"--json",
					"--line-number",
					"--color=never",
					"--smart-case",
					"--no-messages",
					"--max-count",
					"40",
					"--max-filesize",
					"1048576",
					"-e",
					"MAX_RETRIES",
					"--",
					projectPath("src"),
				],
				code: 0,
				stdout: `${[
					rgMatchLine(projectPath("src", "limits.ts"), 1, "export const MAX_RETRIES = 3;\n"),
					rgMatchLine(notesSourcePath, 1, "// Mentions MAX_RETRIES without owning it.\n"),
					rgMatchLine(envSecretPath, 1, "API_TOKEN=MAX_RETRIES_SECRET\n"),
				].join("\n")}\n`,
			},
		]);
	}

	const manager = world.createSessionManager(agentDir);
	const { session } = await world.createRootSession("root", {
		agentDir,
		sessionManager: manager,
		settings: {
			autoLearn: { enabled: false },
			proactivity: { enabled: false },
			orchestrator: { delegationGate: false },
		},
	});
	const results: Record<string, { isError: boolean; text: string }> = {};
	let visionEvidenceId = "";
	const answered = createBarrier();

	world.provider.enqueue(
		"root",
		calls("j4-s1-status-call", [{ id: "j4-s1-status", name: "systemone", arguments: { action: "status" } }]),
		{
			...calls("j4-s1-evaluate-call", [
				{
					id: "j4-s1-evaluate",
					name: "systemone",
					arguments: {
						action: "evaluate",
						evidenceRefs: ["file:src/limits.ts"],
						evaluation: {
							state: STATE,
							questions: {
								limit_is_three: {
									type: "noul",
									instructions: "Does the state and source say the retry limit is 3?",
								},
							},
						},
					},
				},
			]),
			check: (request) => {
				results.status = toolResult(request);
			},
		},
		{
			...calls("j4-s1-review-pass-call", [
				{
					id: "j4-s1-review-pass",
					name: "systemone",
					arguments: {
						action: "review",
						evidenceRefs: ["file:src/limits.ts"],
						review: {
							state: STATE,
							confidence: "high",
							questions: {
								retry_verified: {
									instructions: "Does src/limits.ts define MAX_RETRIES = 3?",
									criteria: { yes: "Defines MAX_RETRIES = 3", no: "Does not define MAX_RETRIES = 3" },
									expected: "yes",
								},
							},
						},
					},
				},
			]),
			check: (request) => {
				results.evaluate = toolResult(request);
			},
		},
		{
			...calls("j4-s1-review-fail-call", [
				{
					id: "j4-s1-review-fail",
					name: "systemone",
					arguments: {
						action: "review",
						review: {
							state: STATE,
							confidence: "high",
							questions: {
								retry_wrong: {
									instructions: "Does the state set MAX_RETRIES to 9?",
									criteria: { yes: "MAX_RETRIES is 9", no: "MAX_RETRIES is not 9" },
									expected: "yes",
								},
							},
						},
					},
				},
			]),
			check: (request) => {
				results.reviewPass = toolResult(request);
			},
		},
		{
			...calls("j4-s1-vision-call", [
				{
					id: "j4-s1-vision",
					name: "systemone",
					arguments: {
						action: "vision",
						vision: {
							state: { pane: "settings" },
							images: {
								"<screen>": {
									path: "ui-screen.png",
									reason: "Inspect the Save and Cancel regions in the settings snapshot",
									crop: { left: 20, top: 10, right: 220, bottom: 190 },
								},
							},
							questions: {
								save_box: { type: "box", instructions: "Save button" },
								save_present: { type: "noul", instructions: null },
								ghost_box: { type: "box", instructions: "Delete workspace button" },
								ghost_present: { type: "noul", instructions: null },
							},
							boxes: {
								save_box: {
									image: "<screen>",
									presenceQuestion: "save_present",
									minimumPresence: 0.9,
									minimumConfidence: 0.9,
								},
								ghost_box: {
									image: "<screen>",
									presenceQuestion: "ghost_present",
									minimumPresence: 0.9,
									minimumConfidence: 0.9,
								},
							},
						},
					},
				},
			]),
			check: (request) => {
				results.reviewFail = toolResult(request);
			},
		},
		{
			...calls("j4-s1-vision-guard-call", [
				{
					id: "j4-s1-vision-guard",
					name: "systemone",
					arguments: {
						action: "vision",
						vision: {
							state: { pane: "protected" },
							images: {
								"<secret>": {
									path: "src/.env",
									reason: "Attempt to read a credential path as an image",
								},
							},
							questions: {
								secret_check: { type: "noul", instructions: "Is anything visible?" },
							},
						},
					},
				},
			]),
			check: (request) => {
				const vision = toolResult(request);
				results.vision = vision;
				if (!vision.isError) {
					const parsed = JSON.parse(vision.text) as { evidence?: { id?: string } };
					visionEvidenceId = parsed.evidence?.id ?? "";
				}
			},
		},
		{
			name: "j4-s1-evidence-call",
			check: (request) => {
				results.visionGuard = toolResult(request);
			},
			reply: () => ({
				content: [
					{
						type: "toolCall",
						id: "j4-s1-evidence",
						name: "systemone",
						arguments: {
							action: "evidence",
							id: visionEvidenceId || "0".repeat(24),
							offset: 0,
						},
					},
				],
				stopReason: "toolUse",
			}),
		},
		{
			...calls("j4-s1-locate-call", [
				{
					id: "j4-s1-locate",
					name: "systemone",
					arguments: {
						action: "locate",
						locate: {
							target: "where MAX_RETRIES is defined",
							queries: ["MAX_RETRIES"],
							paths: ["src"],
						},
					},
				},
			]),
			check: (request) => {
				results.evidence = toolResult(request);
			},
		},
		{
			name: "j4-s1-answer",
			check: (request) => {
				results.locate = toolResult(request);
				answered.release();
			},
			reply: { content: [{ type: "text", text: "System One answered." }] },
		},
	);

	world.systemOne.enterPhase("j4-systemone-tool", {
		...INTAKE_JUDGMENTS,
		limit_is_three: { kind: "noul", probability: 0.97 },
		retry_verified: { kind: "choice", choice: "yes", confidence: 0.96 },
		retry_wrong: { kind: "choice", choice: "no", confidence: 0.94 },
		save_box: { kind: "box", box: { left: 0.25, top: 0.25, right: 0.75, bottom: 0.75 }, confidence: 0.95 },
		save_present: { kind: "noul", probability: 0.96 },
		ghost_box: { kind: "box", box: { left: 0.25, top: 0.25, right: 0.5, bottom: 0.5 }, confidence: 0.93 },
		ghost_present: { kind: "noul", probability: 0.12 },
		locate_c0: { kind: "noul", probability: 0.96 },
		locate_c1: { kind: "noul", probability: 0.08 },
	});

	await withDeadline(
		trace,
		"the System One tool turn",
		session.prompt("Inspect status, evaluate, review, vision, retained evidence, and locate through System One."),
	);
	await withDeadline(trace, "the System One tool answers", answered.promise);
	if (rgDrained) await withDeadline(trace, "ripgrep locate search settles", rgDrained);
	await withDeadline(trace, "the session is at rest", session.waitForForegroundIdle());

	if (!world.systemOne.enabled) {
		const callKeys = [
			"status",
			"evaluate",
			"reviewPass",
			"reviewFail",
			"vision",
			"visionGuard",
			"evidence",
			"locate",
		];
		expect(
			callKeys.map((key) => [
				results[key]?.isError,
				results[key]?.text.includes('Unknown tool name \\"systemone\\".'),
			]),
			"with System One off the tool is not offered: every action is refused as an unknown tool",
		).toEqual(callKeys.map(() => [true, true]));
	} else {
		const status = JSON.parse(results.status?.text ?? "{}") as {
			enabled?: boolean;
			authenticationVerified?: boolean;
			capabilities?: { images?: boolean };
		};
		const evaluation = JSON.parse(results.evaluate?.text ?? "{}") as {
			response?: { answers?: Record<string, unknown> };
			sourceManifest?: Array<{ label?: string; kind?: string }>;
			receipts?: { status: string }[];
			costStatus?: string;
		};
		const reviewPass = JSON.parse(results.reviewPass?.text ?? "{}") as {
			accepted?: boolean;
			failures?: string[];
		};
		const reviewFail = JSON.parse(results.reviewFail?.text ?? "{}") as {
			accepted?: boolean;
			failures?: string[];
		};
		const vision = JSON.parse(results.vision?.text ?? "{}") as {
			kind?: string;
			accepted?: unknown;
			advisoryOnly?: boolean;
			imageManifest?: Array<{
				reference?: string;
				label?: string;
				geometry?: {
					original?: { width: number; height: number };
					crop?: { left: number; top: number; right: number; bottom: number };
					resized?: { width: number; height: number };
					prepared?: { width: number; height: number };
					padding?: { left: number; top: number };
				};
			}>;
			boxes?: Record<
				string,
				{
					candidate?: boolean;
					coordinateSpace?: string;
					presence?: number | null;
					confidence?: number | null;
					sourceRectangle?: { left: number; top: number; right: number; bottom: number };
				}
			>;
			evidence?: { id?: string; bytes?: number };
		};
		const visionGuardDiag = refusalDiagnostic(results.visionGuard?.text ?? "") ?? "";
		const evidenceDir = typeSafeEvidenceDir(agentDir, manager.getSessionId());
		const visionGuardRetained = world.io
			.readdirSync(evidenceDir)
			.filter((name): name is string => typeof name === "string" && name.endsWith(".payload"))
			.map(
				(name) =>
					JSON.parse(String(world.io.readFileSync(join(evidenceDir, name), "utf8"))) as {
						toolCallId?: string;
						record?: { accepted?: unknown; advisoryOnly?: boolean; error?: string };
					},
			)
			.find((entry) => entry.toolCallId === "j4-s1-vision-guard")?.record;
		const evidencePage = JSON.parse(results.evidence?.text ?? "{}") as {
			id?: string;
			offset?: number;
			totalChars?: number;
			nextOffset?: number;
			text?: string;
		};
		const pageText = evidencePage.text ?? "";

		expect(
			{
				errors: [
					results.status?.isError,
					results.evaluate?.isError,
					results.reviewPass?.isError,
					results.reviewFail?.isError,
					results.vision?.isError,
					results.visionGuard?.isError,
					results.evidence?.isError,
					results.locate?.isError,
				],
				status: {
					enabled: status.enabled,
					verified: status.authenticationVerified,
					images: status.capabilities?.images,
				},
				evaluate: {
					answer: evaluation.response?.answers?.limit_is_three,
					sources: evaluation.sourceManifest?.map((entry) => `${entry.kind}:${entry.label}`),
					receipts: evaluation.receipts?.map((receipt) => receipt.status),
					cost: evaluation.costStatus,
				},
				reviewPass: { accepted: reviewPass.accepted, failures: reviewPass.failures },
				reviewFail: { accepted: reviewFail.accepted, failures: reviewFail.failures },
				vision: {
					kind: vision.kind,
					accepted: vision.accepted,
					advisoryOnly: vision.advisoryOnly,
					geometry: vision.imageManifest?.[0]?.geometry,
					saveBox: vision.boxes?.save_box,
					ghostCandidate: vision.boxes?.ghost_box?.candidate,
					ghostRectangle: vision.boxes?.ghost_box?.sourceRectangle,
				},
				visionGuard: {
					bouncedByHarness: Boolean(results.visionGuard?.text.startsWith("[harness] {")),
					advisoryHeader: visionGuardDiag.startsWith(
						'{"accepted":null,"kind":"system_one_vision","advisoryOnly":true,',
					),
					retainedAccepted: visionGuardRetained?.accepted,
					retainedAdvisoryOnly: visionGuardRetained?.advisoryOnly,
					refusedProtectedPath: Boolean(
						visionGuardRetained?.error?.includes("outside protected credential paths, and within the byte limit"),
					),
				},
				evidence: {
					sameId: evidencePage.id === visionEvidenceId && visionEvidenceId.length === 24,
					offset: evidencePage.offset,
					pagedCleanly:
						typeof evidencePage.totalChars === "number" &&
						evidencePage.totalChars >= pageText.length &&
						(evidencePage.totalChars > pageText.length
							? evidencePage.nextOffset === pageText.length
							: evidencePage.nextOffset === undefined),
					headerMatchesVisionCall: pageText.startsWith('{"version":1,"toolCallId":"j4-s1-vision","record":{'),
				},
				locate: {
					excludedProtectedBanner: Boolean(
						results.locate?.text.includes("1 matching files left out (out of scope, protected"),
					),
					judgedSummary: Boolean(
						results.locate?.text.includes("locate: judged 2 of 2 candidate files in 1 request."),
					),
					acceptedTopHit: Boolean(results.locate?.text.includes("src/limits.ts:1  p=0.96")),
					belowFloorSecond: Boolean(results.locate?.text.includes("src/notes.ts:1  p=0.08 (below floor)")),
					excludesEnvSecret:
						!results.locate?.text.includes(".env") && !results.locate?.text.includes("MAX_RETRIES_SECRET"),
				},
			},
			"System One status, evaluate, review, vision, retained evidence, and locate uphold their contracts and boundaries",
		).toEqual({
			errors: [false, false, false, false, false, true, false, false],
			status: { enabled: true, verified: true, images: true },
			evaluate: {
				answer: { type: "noul", noul: 0.97 },
				sources: ["file:src/limits.ts"],
				receipts: ["recorded"],
				cost: "catalog_priced",
			},
			reviewPass: { accepted: true, failures: [] },
			reviewFail: { accepted: false, failures: ["retry_wrong"] },
			vision: {
				kind: "system_one_vision",
				accepted: null,
				advisoryOnly: true,
				geometry: {
					original: { width: 300, height: 240 },
					upright: { width: 300, height: 240 },
					crop: { left: 20, top: 10, right: 220, bottom: 190 },
					resized: { width: 200, height: 180 },
					prepared: { width: 280, height: 280 },
					padding: { left: 40, top: 50 },
				},
				saveBox: {
					image: "<screen>",
					preparedSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
					candidate: true,
					coordinateSpace: "upright_source_pixels",
					presence: 0.96,
					confidence: 0.95,
					minimumPresence: 0.9,
					minimumConfidence: 0.9,
					sourceRectangle: { left: 50, top: 30, right: 190, bottom: 170 },
				},
				ghostCandidate: false,
				ghostRectangle: undefined,
			},
			visionGuard: {
				bouncedByHarness: true,
				advisoryHeader: true,
				retainedAccepted: null,
				retainedAdvisoryOnly: true,
				refusedProtectedPath: true,
			},
			evidence: {
				sameId: true,
				offset: 0,
				pagedCleanly: true,
				headerMatchesVisionCall: true,
			},
			locate: {
				excludedProtectedBanner: true,
				judgedSummary: true,
				acceptedTopHit: true,
				belowFloorSecond: true,
				excludesEnvSecret: true,
			},
		});
	}

	expect(await world.disposeSessionInBody(session), "the System One tool session closes").toBeUndefined();
	trace.mark("root", "systemone-tool.closed");
}
