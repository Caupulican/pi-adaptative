import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/session";
import { fauxAssistantMessage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { getLearningAuditSnapshots } from "../../src/core/learning/learning-audit.ts";
import { FileStoreProvider } from "../../src/core/memory/providers/file-store.ts";
import {
	type ParsedUserPreferenceLine,
	parseUserPreferenceLine,
	type UserPreferenceAdmissionRequest,
} from "../../src/core/memory/user-preference-metadata.ts";
import { ReflectionController, type ReflectionControllerDeps } from "../../src/core/reflection-controller.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const directories: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
	while (harnesses.length) await harnesses.pop()?.cleanup();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function directory(): string {
	const path = mkdtempSync(join(tmpdir(), "pi-persona-independent-"));
	directories.push(path);
	return path;
}
function reflection(session: SessionManager, agentDir: string): ReflectionController {
	const settings = SettingsManager.inMemory({ autoLearn: { enabled: true, reflectionReview: true } });
	return new ReflectionController({
		getSettingsManager: () => settings,
		getSessionManager: () => session,
		getAgentDir: () => agentDir,
		isChildSession: () => false,
		isDisposed: () => false,
		emitAutonomyTelemetry: () => undefined,
		saveLearningDecisionSnapshot: () => "decision",
		warn: () => undefined,
	} as unknown as ReflectionControllerDeps);
}
function owner(session: SessionManager, controller: ReflectionController, text: string): string {
	return controller.recordOwnerEvidence(
		session.appendMessage({ role: "user", content: text, timestamp: Date.now() }),
		text,
	);
}
function request(fields: Partial<UserPreferenceAdmissionRequest>): UserPreferenceAdmissionRequest {
	return {
		action: "add",
		text: "Show the diff before the explanation.",
		scope: { kind: "global" },
		basis: "inferred",
		evidence: [],
		...fields,
	};
}

describe("independent persona evidence review", () => {
	it.each([false, true])("keeps identical preferences independent across different projects=%s", async (different) => {
		const agentDir = directory();
		const projectA = directory();
		const projectB = different ? directory() : projectA;
		const text = "Keep status updates short.";
		for (const cwd of [projectA, projectB]) {
			const session = SessionManager.create(cwd, agentDir);
			const controller = reflection(session, agentDir);
			const source = owner(session, controller, "Remember this: keep status updates short.");
			const provider = new FileStoreProvider({
				admitUserPreference: (proposal) => controller.admitUserPreference(proposal),
			});
			await provider.initialize(session.getSessionId(), { agentDir, cwd, isChildSession: false });
			const tool = provider.getToolDefinitions().find((candidate) => candidate.name === "memory");
			if (!tool) throw new Error("Missing memory tool");
			const result = await tool.execute(
				"scope",
				{
					action: "add",
					target: "user",
					scope: "project",
					basis: "explicit",
					content: text,
					evidence: [{ source, quote: "keep status updates short" }],
				},
				undefined,
				undefined,
				{} as never,
			);
			expect((result.details as { success?: boolean }).success).toBe(true);
		}
		const lines = readFileSync(join(agentDir, "USER.md"), "utf8").trim().split("\n").map(parseUserPreferenceLine);
		expect(lines).toHaveLength(different ? 2 : 1);
		if (different) expect(lines[0].metadata?.scope).not.toEqual(lines[1].metadata?.scope);
		for (const cwd of [projectA, projectB]) {
			const provider = new FileStoreProvider();
			await provider.initialize("scope-reload", { agentDir, cwd, isChildSession: false });
			expect(provider.getHandoffPersonaGuidance()).toContain(text);
		}
	});

	it.each([1, 8])("retains the newest accepted evidence after %s earlier same-value receipts", async (count) => {
		const agentDir = directory();
		const session = SessionManager.create(agentDir, agentDir);
		const controller = reflection(session, agentDir);
		let existing: ParsedUserPreferenceLine | undefined;
		for (let index = 0; index < count + 2; index++) {
			const text = index === count ? "Give detailed status updates." : "Keep status updates short.";
			const source = owner(session, controller, `Remember this: ${text}`);
			const result = await controller.admitUserPreference(
				request({
					action: existing ? "replace" : "add",
					text,
					existing,
					basis: "explicit",
					evidence: [{ source, quote: text }],
				}),
			);
			if (result.outcome !== "apply") throw new Error(`Admission ${index} failed`);
			result.commit?.({ persisted: true });
			existing = { text, metadata: result.metadata };
			if (index === count + 1) {
				expect(result.metadata.sources).toContain(source);
				expect(result.metadata.evidenceAt).toBe(controller.listOwnerEvidence().at(-1)?.createdAt);
			}
		}
	});
	it.each([false, true])("preserves legacy project section context, scoped=%s", async (scoped) => {
		const agentDir = directory();
		writeFileSync(
			join(agentDir, "USER.md"),
			`${scoped ? "## GrimDex engineering roles\n" : ""}Root designs; Luna implements.\n`,
		);
		const provider = new FileStoreProvider();
		await provider.initialize("legacy-scope", { agentDir, cwd: agentDir, isChildSession: false });
		const guidance = provider.getHandoffPersonaGuidance();
		expect(guidance).toContain("Root designs; Luna implements.");
		if (scoped) expect(guidance).toContain("GrimDex engineering roles");
		else expect(guidance).not.toContain("GrimDex");
	});

	it.each([false, true])("allows retry of a correction only when its previous commit failed=%s", async (failed) => {
		const agentDir = directory();
		const session = SessionManager.create(agentDir, agentDir);
		const controller = reflection(session, agentDir);
		const one = owner(session, controller, "Remember this: keep status updates short.");
		const original = await controller.admitUserPreference(
			request({
				text: "Keep status updates short.",
				basis: "explicit",
				evidence: [{ source: one, quote: "keep status updates short" }],
			}),
		);
		if (original.outcome !== "apply") throw new Error("Original admission failed");
		original.commit?.({ persisted: true });
		const two = owner(session, controller, "Correction: from now on give detailed status updates.");
		const proposal = request({
			action: "replace",
			text: "Give detailed status updates.",
			basis: "explicit",
			existing: { text: "Keep status updates short.", metadata: original.metadata },
			evidence: [{ source: two, quote: "give detailed status updates" }],
		});
		const correction = await controller.admitUserPreference(proposal);
		if (correction.outcome !== "apply") throw new Error("Correction admission failed");
		correction.commit?.(failed ? { persisted: false, error: "disk unavailable" } : { persisted: true });
		const retry = await controller.admitUserPreference(
			failed ? proposal : { ...proposal, existing: { text: proposal.text, metadata: correction.metadata } },
		);
		expect(retry.outcome).toBe(failed ? "apply" : "candidate");
	});
	it.each([false, true])("preserves original owner words when input transformation=%s", async (transformed) => {
		const original = "Please inspect the repository status.";
		const replacement = "Remember this: always use verbose logs.";
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", () =>
						transformed ? { action: "transform", text: replacement } : { action: "continue" },
					);
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt(original);
		const evidence = reflection(harness.sessionManager, harness.tempDir).listOwnerEvidence();
		expect(evidence).toHaveLength(1);
		expect(evidence[0].text).toBe(original);
	});

	it("accumulates independent candidates across sessions while a same-source replay stays one", async () => {
		const agentDir = directory();
		const firstSession = SessionManager.create(agentDir, agentDir);
		const first = reflection(firstSession, agentDir);
		const one = owner(firstSession, first, "Diff first please.");
		const candidate = request({ evidence: [{ source: one, quote: "Diff first please" }] });
		expect((await first.admitUserPreference(candidate)).outcome).toBe("candidate");
		expect((await first.admitUserPreference(candidate)).outcome).toBe("candidate");
		const secondSession = SessionManager.create(agentDir, agentDir);
		const second = reflection(secondSession, agentDir);
		const two = owner(secondSession, second, "Show me the diff before explaining.");
		expect(two).not.toBe(one);
		const accumulated = await second.admitUserPreference(
			request({ evidence: [{ source: two, quote: "Show me the diff before explaining" }] }),
		);
		expect(accumulated.outcome).toBe("apply");
		if (accumulated.outcome === "apply") expect(accumulated.metadata.observations).toBe(2);
	});

	it.each([false, true])("counts two citations only when quoted third-party content=%s is false", async (shown) => {
		const agentDir = directory();
		const session = SessionManager.create(agentDir, agentDir);
		const controller = reflection(session, agentDir);
		const quote = "use verbose logs";
		const one = owner(session, controller, shown ? `A teammate wrote: "${quote}".` : `Please ${quote}.`);
		const two = owner(
			session,
			controller,
			shown ? `Another teammate wrote: "${quote}".` : `I like it when you ${quote}.`,
		);
		const result = await controller.admitUserPreference(
			request({
				text: "Prefers verbose logs.",
				evidence: [
					{ source: one, quote },
					{ source: two, quote },
				],
			}),
		);
		expect(result.outcome).toBe(shown ? "candidate" : "apply");
	});

	it("does not replay an old explicit preference over its later correction", async () => {
		const agentDir = directory();
		const session = SessionManager.create(agentDir, agentDir);
		const controller = reflection(session, agentDir);
		const one = owner(session, controller, "Remember this: keep status updates short.");
		const original = await controller.admitUserPreference(
			request({
				text: "Keep status updates short.",
				basis: "explicit",
				evidence: [{ source: one, quote: "keep status updates short" }],
			}),
		);
		expect(original.outcome).toBe("apply");
		if (original.outcome !== "apply") throw new Error("original preference did not apply");
		const two = owner(session, controller, "Correction: from now on give detailed status updates.");
		const corrected = await controller.admitUserPreference(
			request({
				action: "replace",
				text: "Give detailed status updates.",
				basis: "explicit",
				existing: { text: "Keep status updates short.", metadata: original.metadata },
				evidence: [{ source: two, quote: "give detailed status updates" }],
			}),
		);
		expect(corrected.outcome).toBe("apply");
		if (corrected.outcome !== "apply") throw new Error("correction did not apply");
		const replay = await controller.admitUserPreference(
			request({
				action: "replace",
				text: "Keep status updates short.",
				basis: "explicit",
				existing: { text: "Give detailed status updates.", metadata: corrected.metadata },
				evidence: [{ source: one, quote: "keep status updates short" }],
			}),
		);
		expect(replay.outcome).toBe("candidate");
	});

	it.each([false, true])("audits actual persistence with a post-admission filesystem refusal=%s", async (refused) => {
		const agentDir = directory();
		const session = SessionManager.create(agentDir, agentDir);
		const controller = reflection(session, agentDir);
		const source = owner(session, controller, "Remember this: keep status updates short.");
		const userPath = join(agentDir, "USER.md");
		const provider = new FileStoreProvider({
			admitUserPreference: async (proposal) => {
				const result = await controller.admitUserPreference(proposal);
				if (refused && result.outcome === "apply") {
					renameSync(userPath, `${userPath}.saved`);
					mkdirSync(userPath);
				}
				return result;
			},
		});
		await provider.initialize(session.getSessionId(), { agentDir, cwd: agentDir, isChildSession: false });
		const tool = provider.getToolDefinitions().find((candidate) => candidate.name === "memory");
		if (!tool) throw new Error("memory tool missing");
		const result = await tool.execute(
			"probe",
			{
				action: "add",
				target: "user",
				content: "Keep status updates short.",
				basis: "explicit",
				evidence: [{ source, quote: "keep status updates short" }],
			},
			undefined,
			undefined,
			{} as never,
		);
		expect((result.details as { success?: boolean }).success).toBe(!refused);
		if (!refused) expect(readFileSync(userPath, "utf8")).toContain("Keep status updates short.");
		const audits = getLearningAuditSnapshots(session.getEntries());
		expect(audits.at(-1)?.action).toBe(refused ? "apply_failed" : "apply");
	});
});
