/**
 * USER.md working preferences reach the NEXT actual provider request.
 *
 * The static memory block is frozen for the session (prompt-cache stability), so a preference the
 * owner adds, replaces or removes mid-session used to reach the model only in the next session.
 * These tests read the wire payload the faux provider receives (through the `before_provider_request`
 * hook the harness routes every payload through) and prove what each request carried: the initial
 * preference in the static block, a mid-session replacement as one `user_persona` record on the
 * continuation request, an explicit "USER.md is empty" record after removal, byte-stable static
 * prefix and no re-sent record while nothing changes, survival across compaction, a superseding
 * record after reload, and nothing at all with memory disabled. A faux model executes scripted tool
 * calls; nothing here claims the real model's semantic judgment about what to store.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TRANSIENT_RECORD_SUPERSEDING_NOTE } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/session";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { memoryTextFitsBudget, resolveMemoryPromptBudget } from "../../src/core/context/memory-prompt-budget.ts";
import { getLearningAuditSnapshots } from "../../src/core/learning/learning-audit.ts";
import { FileStoreProvider } from "../../src/core/memory/providers/file-store.ts";
import { parseUserPreferenceLine } from "../../src/core/memory/user-preference-metadata.ts";
import { PERSONA_PROJECTION_RULE } from "../../src/core/provider-prompt-contracts.ts";
import { getOwnerEvidenceSnapshots } from "../../src/core/reflection-controller.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";
import { createTestResourceLoader } from "./test-resources.ts";

interface WirePayload {
	systemPrompt: string;
	messages: Array<{ role: string; content: unknown }>;
}

function messageText(message: { content: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function personaRecords(payload: WirePayload): string[] {
	return payload.messages.map(messageText).filter((text) => text.startsWith("USER PERSONA"));
}

async function createPersonaHarness(
	options: Pick<HarnessOptions, "settings" | "models"> & { initializeMemory?: boolean } = {},
): Promise<{ harness: Harness; payloads: WirePayload[]; userPath: string }> {
	const payloads: WirePayload[] = [];
	const harness = await createHarness({
		...options,
		extensionFactories: [
			(pi) => {
				pi.on("before_provider_request", (event) => {
					const payload = event.payload as { systemPrompt?: unknown; messages?: unknown };
					payloads.push({
						systemPrompt: typeof payload.systemPrompt === "string" ? payload.systemPrompt : "",
						messages: Array.isArray(payload.messages) ? (payload.messages as WirePayload["messages"]) : [],
					});
					return undefined;
				});
			},
		],
	});
	// The SDK entry point initializes memory before returning; the raw harness leaves it to the
	// caller. Scenarios that seed USER.md externally initialize through `seedUser` (a reload that
	// adopts the seeded file); scenarios that start empty initialize here.
	if (options.initializeMemory) await harness.session.initializeMemory();
	return { harness, payloads, userPath: join(harness.tempDir, "USER.md") };
}

const INITIAL = "Prefers tabs over spaces for indentation.";
const REPLACEMENT = "Prefers spaces over tabs for indentation.";

async function seedUser(harness: Harness, userPath: string, content: string): Promise<void> {
	writeFileSync(userPath, `${content}\n`, "utf8");
	// Initialization reads the durable owner: a reload re-initializes the memory subsystem from disk.
	await harness.session.reload();
}

async function runMemoryTurn(harness: Harness, prompt: string, params: Record<string, unknown>): Promise<void> {
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("memory", params)], { stopReason: "toolUse" }),
		fauxAssistantMessage("noted"),
	]);
	await harness.session.prompt(prompt);
}

async function runPlainTurn(harness: Harness, prompt: string): Promise<void> {
	harness.setResponses([fauxAssistantMessage("ok")]);
	await harness.session.prompt(prompt);
}

function ownerSources(harness: Harness): string[] {
	return getOwnerEvidenceSnapshots(harness.sessionManager.getEntries()).map((evidence) => evidence.sourceId);
}

function audits(harness: Harness) {
	return getLearningAuditSnapshots(harness.sessionManager.getEntries());
}

/** Wait until the session is neither streaming nor holding queued input (bounded). */
async function waitForIdle(harness: Harness): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (!harness.session.isStreaming && harness.session.pendingMessageCount === 0) {
			await new Promise((resolve) => setTimeout(resolve, 25));
			if (!harness.session.isStreaming) return;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("session did not become idle");
}

/** The owner states something in their own words; returns the source id a later write may cite. */
async function ownerSays(harness: Harness, text: string): Promise<string> {
	await runPlainTurn(harness, text);
	return ownerSources(harness).at(-1) as string;
}

const REPLACEMENT_SPOKEN = "prefer spaces over tabs for indentation";

/** The owner asks for the replacement explicitly, then the model writes it citing those words. */
async function ownerReplacesInitial(harness: Harness): Promise<string> {
	const source = await ownerSays(harness, `From now on, ${REPLACEMENT_SPOKEN}.`);
	await runMemoryTurn(harness, "switch to spaces", {
		action: "replace",
		target: "user",
		oldContent: INITIAL,
		content: REPLACEMENT,
		basis: "explicit",
		evidence: [{ source, quote: REPLACEMENT_SPOKEN }],
	});
	return source;
}

describe("USER.md persona delivery to the next provider request", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it("the initial preference and the projection rule ride in the static block; no record is sent", async () => {
		const { harness, payloads, userPath } = await createPersonaHarness();
		harnesses.push(harness);
		await seedUser(harness, userPath, INITIAL);
		await runPlainTurn(harness, "hello");
		expect(payloads).toHaveLength(1);
		expect(payloads[0].systemPrompt).toContain(`## USER.md:\n${PERSONA_PROJECTION_RULE}\n- ${INITIAL}`);
		expect(personaRecords(payloads[0])).toEqual([]);
	});

	it("a replacement reaches the continuation request as one record while the static prefix stays byte-stable", async () => {
		const { harness, payloads, userPath } = await createPersonaHarness();
		harnesses.push(harness);
		await seedUser(harness, userPath, INITIAL);
		await ownerReplacesInitial(harness);
		expect(readFileSync(userPath, "utf8")).toContain(REPLACEMENT);
		expect(payloads).toHaveLength(3);
		// The owner's statement and the request that carried the tool call had nothing new to say.
		expect(personaRecords(payloads[0])).toEqual([]);
		expect(personaRecords(payloads[1])).toEqual([]);
		// The automated continuation (tool result, no owner input) receives the current preferences.
		const records = personaRecords(payloads[2]);
		expect(records).toHaveLength(1);
		expect(records[0]).toContain("USER PERSONA (USER.md revision ");
		expect(records[0]).toContain(PERSONA_PROJECTION_RULE);
		expect(records[0]).toContain("supersedes the USER.md section of the static memory block");
		expect(records[0]).toContain(`- ${REPLACEMENT} (explicit)`);
		expect(records[0]).not.toContain(INITIAL);
		// Static prefix unchanged: still the frozen block with the old line.
		expect(payloads[2].systemPrompt).toBe(payloads[0].systemPrompt);
		expect(payloads[2].systemPrompt).toContain(INITIAL);
	});

	it("an unchanged persona is never re-sent: later requests carry the one durable record", async () => {
		const { harness, payloads, userPath } = await createPersonaHarness();
		harnesses.push(harness);
		await seedUser(harness, userPath, INITIAL);
		await ownerReplacesInitial(harness);
		await runPlainTurn(harness, "next");
		await runPlainTurn(harness, "and again");
		expect(payloads).toHaveLength(5);
		for (const payload of payloads.slice(2)) {
			expect(personaRecords(payload)).toHaveLength(1);
			expect(payload.systemPrompt).toBe(payloads[0].systemPrompt);
		}
		// The record sits where it was first appended; later requests only grow after it.
		const firstIndex = payloads[2].messages.findIndex((message) => messageText(message).startsWith("USER PERSONA"));
		const lastIndex = payloads[4].messages.findIndex((message) => messageText(message).startsWith("USER PERSONA"));
		expect(firstIndex).toBeGreaterThan(0);
		expect(lastIndex).toBe(firstIndex);
	});

	it("removing the only preference sends an explicit empty record; restoring the frozen content supersedes it", async () => {
		const { harness, payloads, userPath } = await createPersonaHarness();
		harnesses.push(harness);
		await seedUser(harness, userPath, INITIAL);
		const forget = await ownerSays(harness, "From now on, don't keep my indentation preference.");
		await runMemoryTurn(harness, "forget that", {
			action: "remove",
			target: "user",
			oldContent: INITIAL,
			basis: "explicit",
			evidence: [{ source: forget, quote: "don't keep my indentation preference" }],
		});
		expect(readFileSync(userPath, "utf8").trim()).toBe("");
		const removed = personaRecords(payloads[2]);
		expect(removed).toHaveLength(1);
		expect(removed[0]).toContain("USER.md is empty");
		expect(removed[0]).toContain("no standing preferences apply");
		expect(removed[0]).toContain("superseded");
		expect(removed[0]).not.toContain(INITIAL);
		// Static prefix still shows the old line by design; the record is what says it no longer holds.
		expect(payloads[2].systemPrompt).toContain(INITIAL);

		// Re-stated explicitly, the preference comes back as a new evidence-backed revision, so the
		// next request receives it as a record (the frozen block only knew the unannotated line).
		const restate = await ownerSays(harness, "Remember this: prefer tabs over spaces for indentation.");
		await runMemoryTurn(harness, "put it back", {
			action: "add",
			target: "user",
			content: INITIAL,
			basis: "explicit",
			evidence: [{ source: restate, quote: "prefer tabs over spaces for indentation" }],
		});
		// Records are append-only: the empty record stays in history and the new one supersedes it.
		const restored = personaRecords(payloads.at(-1) as WirePayload);
		expect(restored).toHaveLength(2);
		expect(restored[1]).toContain(`- ${INITIAL} (explicit)`);
		expect(restored[1]).toContain("supersedes the USER.md section of the static memory block");
	});

	it("survives compaction as one carried record and yields a superseding record after reload", async () => {
		const payloads: WirePayload[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_provider_request", (event) => {
						const payload = event.payload as { systemPrompt?: unknown; messages?: unknown };
						payloads.push({
							systemPrompt: typeof payload.systemPrompt === "string" ? payload.systemPrompt : "",
							messages: Array.isArray(payload.messages) ? (payload.messages as WirePayload["messages"]) : [],
						});
						return undefined;
					});
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary: the owner switched to spaces",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		const userPath = join(harness.tempDir, "USER.md");
		await seedUser(harness, userPath, INITIAL);
		await ownerReplacesInitial(harness);
		await runPlainTurn(harness, "next");
		await harness.session.compact();
		expect(harness.session.messages[0]?.role).toBe("compactionSummary");

		await runPlainTurn(harness, "after compaction");
		const afterCompaction = payloads.at(-1);
		if (!afterCompaction) throw new Error("expected a request after compaction");
		const records = personaRecords(afterCompaction);
		expect(records).toHaveLength(1);
		expect(records[0]).toContain(REPLACEMENT);
		expect(afterCompaction.systemPrompt).toContain(INITIAL);

		// Reload re-initializes memory from the durable owner: the static block now carries the
		// replacement and the earlier record is explicitly superseded rather than left to read as current.
		await harness.session.reload();
		await runPlainTurn(harness, "after reload");
		const afterReload = payloads.at(-1);
		if (!afterReload) throw new Error("expected a request after reload");
		expect(afterReload.systemPrompt).toContain(
			`## USER.md:\n${PERSONA_PROJECTION_RULE}\n- ${REPLACEMENT} (explicit)`,
		);
		expect(afterReload.systemPrompt).not.toContain(INITIAL);
		const reloadRecords = personaRecords(afterReload);
		expect(reloadRecords.at(-1)).toContain("USER.md section of the static memory block is current again");
	});

	it("negative control: memory disabled or excluded from the prompt sends no record", async () => {
		for (const memory of [{ enabled: false }, { includeInPrompt: false }]) {
			const { harness, payloads, userPath } = await createPersonaHarness({
				settings: { contextPolicy: { memory } },
			});
			harnesses.push(harness);
			await seedUser(harness, userPath, INITIAL);
			await ownerReplacesInitial(harness);
			expect(readFileSync(userPath, "utf8")).toContain(REPLACEMENT);
			expect(payloads).toHaveLength(3);
			expect(personaRecords(payloads[2])).toEqual([]);
		}
	});

	it("disabling memory mid-session clears the standing record without leaking it; re-enabling re-delivers", async () => {
		const { harness, payloads, userPath } = await createPersonaHarness();
		harnesses.push(harness);
		await seedUser(harness, userPath, INITIAL);
		await ownerReplacesInitial(harness);
		expect(personaRecords(payloads[2])).toHaveLength(1);

		harness.settingsManager.setMemoryRetrievalSettings({ enabled: false });
		await runPlainTurn(harness, "memory is off now");
		const disabled = personaRecords(payloads.at(-1) as WirePayload);
		expect(disabled).toHaveLength(2);
		expect(disabled[1]).toContain("memory is disabled or excluded from the prompt");
		expect(disabled[1]).not.toContain(REPLACEMENT);
		expect(disabled[1]).not.toContain(INITIAL);
		// Nothing more is sent while it stays off.
		await runPlainTurn(harness, "still off");
		expect(personaRecords(payloads.at(-1) as WirePayload)).toHaveLength(2);

		harness.settingsManager.setMemoryRetrievalSettings({ enabled: true });
		await runPlainTurn(harness, "memory is on again");
		const reenabled = personaRecords(payloads.at(-1) as WirePayload);
		expect(reenabled).toHaveLength(3);
		expect(reenabled[2]).toContain(REPLACEMENT);
	});

	it("a constrained model receives a record bounded to the existing memory prompt budget, note included", async () => {
		// 8k context: static memory shares the system-prompt allowance; omitted preferences
		// arrive as a persona record. Its 3% context budget is smaller than ten lines.
		// Such a model has no memory tool (minimal
		// capability class), so the mutation arrives through operator authority: an external edit
		// adopted with /memory accept, which commits USER.md exactly like a tool write does.
		const contextWindow = 8192;
		const { harness, payloads, userPath } = await createPersonaHarness({
			models: [{ id: "faux-constrained", contextWindow, maxTokens: 1024 }],
		});
		harnesses.push(harness);
		await seedUser(harness, userPath, INITIAL);
		await runPlainTurn(harness, "hello");
		const preferences = Array.from(
			{ length: 10 },
			(_, index) =>
				`Preference ${index}: communicate progress with concise engineering evidence and clear verification details.`,
		);
		writeFileSync(userPath, `${preferences.join("\n")}\n`, "utf8");
		expect(await harness.session.memoryAcceptDrift("user")).toMatchObject({ ok: true });
		await runPlainTurn(harness, "now with many preferences");
		expect(payloads).toHaveLength(2);
		expect(payloads[0].systemPrompt.length).toBeLessThanOrEqual(4096);
		expect(personaRecords(payloads[0])).toHaveLength(1);
		expect(personaRecords(payloads[0])[0]).toContain(INITIAL);
		const records = personaRecords(payloads[1]);
		expect(records).toHaveLength(2);
		const current = records[1];
		const budget = resolveMemoryPromptBudget({ contextWindow });
		expect(current.endsWith(TRANSIENT_RECORD_SUPERSEDING_NOTE)).toBe(true);
		expect(memoryTextFitsBudget(current, budget)).toBe(true);
		expect(current).toContain(PERSONA_PROJECTION_RULE);
		expect(current).not.toContain(INITIAL);
		const shown = current
			.split("\n")
			.filter((line) => line.startsWith("- Preference "))
			.map((line) => line.slice(2));
		for (const line of shown) expect(preferences).toContain(line);
		expect(shown.length).toBeGreaterThan(0);
		expect(current).toContain(`(${10 - shown.length} more preference lines on disk; not shown`);
		// The static prefix did not move for the mutation.
		expect(payloads[1].systemPrompt).toBe(payloads[0].systemPrompt);
	});

	it.each([false, true])("delivers startup drift=%s to a subscriber attached after SDK creation", async (drift) => {
		const harness = await createHarness();
		harnesses.push(harness);
		const writer = new FileStoreProvider();
		await writer.initialize("seed", { agentDir: harness.tempDir, cwd: harness.tempDir, isChildSession: false });
		writeFileSync(join(harness.tempDir, "USER.md"), "User prefers short status updates.\n");
		await writer.acceptDrift("user");
		if (drift) writeFileSync(join(harness.tempDir, "USER.md"), "User prefers detailed status updates.\n");
		const { session } = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			model: harness.getModel(),
			authStorage: harness.authStorage,
			settingsManager: harness.settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader: createTestResourceLoader(),
		});
		try {
			const warnings: string[] = [];
			session.subscribe((event) => {
				if (event.type === "warning") warnings.push(event.message);
			});
			expect(warnings.filter((text) => text.includes("USER.md differs"))).toHaveLength(drift ? 1 : 0);
			// The held warning is delivered once: a second subscriber does not receive it again.
			const second: string[] = [];
			session.subscribe((event) => {
				if (event.type === "warning") second.push(event.message);
			});
			expect(second).toEqual([]);
			// A live subscriber receives a later notice directly: a reload over the same drifted
			// revision repeats nothing, a new revision is a new fact.
			await session.reload();
			expect(warnings.filter((text) => text.includes("USER.md differs"))).toHaveLength(drift ? 1 : 0);
			writeFileSync(join(harness.tempDir, "USER.md"), "User prefers a third style.\n");
			await session.reload();
			expect(warnings.filter((text) => text.includes("USER.md differs"))).toHaveLength(drift ? 2 : 1);
		} finally {
			await session.disposeAndWait();
		}
	});

	// ---- Phase 2: owner evidence -> live memory tool -> persisted fact -> next payload ----

	it("an explicit communication-style preference cited from the owner's own words lands with metadata and reaches the next payload", async () => {
		const { harness, payloads, userPath } = await createPersonaHarness({ initializeMemory: true });
		harnesses.push(harness);
		await runPlainTurn(harness, "From now on, keep status updates short.");
		const [source] = ownerSources(harness);
		expect(source).toMatch(/^[A-Za-z0-9._:-]{1,16}\/[A-Za-z0-9._:-]+$/);
		await runMemoryTurn(harness, "thanks", {
			action: "add",
			target: "user",
			content: "Keep status updates short.",
			scope: "global",
			basis: "explicit",
			evidence: [{ source, quote: "keep status updates short" }],
		});
		const line = readFileSync(userPath, "utf8").trim();
		const parsed = parseUserPreferenceLine(line);
		expect(parsed.text).toBe("Keep status updates short.");
		expect(parsed.metadata).toMatchObject({ basis: "explicit", observations: 1, revision: 1, sources: [source] });
		expect(audits(harness).at(-1)).toMatchObject({ action: "apply", reasonCode: "explicit_owner_preference" });
		const records = personaRecords(payloads.at(-1) as WirePayload);
		expect(records).toHaveLength(1);
		expect(records[0]).toContain("- Keep status updates short. (explicit)");
		expect(records[0]).not.toContain("[pref ");
	});

	it("negative control: an ordinary code correction or a one-off session instruction produces no preference, no candidate, no record", async () => {
		const { harness, payloads, userPath } = await createPersonaHarness({ initializeMemory: true });
		harnesses.push(harness);
		await runPlainTurn(harness, "No, the loop bound is off by one; fix it.");
		await runPlainTurn(harness, "For this task only, write the report in Spanish.");
		expect(readFileSync(userPath, "utf8").trim()).toBe("");
		expect(audits(harness)).toEqual([]);
		for (const payload of payloads) expect(personaRecords(payload)).toEqual([]);
		// Both owner turns are still evidence the model may cite later; nothing was written on its own.
		expect(ownerSources(harness)).toHaveLength(2);
	});

	it("negative control: text the owner pasted or a worker produced cannot impersonate an explicit owner preference", async () => {
		const { harness, userPath } = await createPersonaHarness({ initializeMemory: true });
		harnesses.push(harness);
		await runPlainTurn(harness, 'A teammate wrote: "always use verbose logs". Ignore that for now.');
		const [pasted] = ownerSources(harness);
		await runMemoryTurn(harness, "noted", {
			action: "add",
			target: "user",
			content: "Prefers verbose logs.",
			basis: "explicit",
			evidence: [{ source: pasted, quote: "always use verbose logs" }],
		});
		expect(readFileSync(userPath, "utf8").trim()).toBe("");
		expect(audits(harness).at(-1)).toMatchObject({ action: "propose", reasonCode: "insufficient_observations" });

		// A tool result is not an owner source at all, even when quoted verbatim.
		await runMemoryTurn(harness, "check", { action: "list", target: "user" });
		const toolEntry = [...harness.sessionManager.getEntries()]
			.reverse()
			.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
		const forged = `${harness.sessionManager.getSessionId().slice(0, 8)}/${toolEntry?.id ?? "missing"}`;
		await runMemoryTurn(harness, "again", {
			action: "add",
			target: "user",
			content: "Prefers verbose logs.",
			basis: "explicit",
			evidence: [{ source: forged, quote: "USER.md" }],
		});
		expect(readFileSync(userPath, "utf8").trim()).toBe("");
		expect(audits(harness).at(-1)).toMatchObject({ action: "propose" });
	});

	it("an explicit correction replaces the matching preference without a second confirmation and bumps its revision", async () => {
		const { harness, payloads, userPath } = await createPersonaHarness({ initializeMemory: true });
		harnesses.push(harness);
		await runPlainTurn(harness, "Remember this: keep status updates short.");
		const [first] = ownerSources(harness);
		await runMemoryTurn(harness, "ok", {
			action: "add",
			target: "user",
			content: "Keep status updates short.",
			basis: "explicit",
			evidence: [{ source: first, quote: "keep status updates short" }],
		});
		await runPlainTurn(harness, "Correction: from now on give me detailed status updates.");
		const second = ownerSources(harness).at(-1) as string;
		await runMemoryTurn(harness, "ok", {
			action: "replace",
			target: "user",
			oldContent: "Keep status updates short.",
			content: "Give detailed status updates.",
			basis: "explicit",
			evidence: [{ source: second, quote: "give me detailed status updates" }],
			expectedRevision: 1,
		});
		const parsed = parseUserPreferenceLine(readFileSync(userPath, "utf8").trim());
		expect(parsed.text).toBe("Give detailed status updates.");
		// The correction's own evidence supports the new value; the superseded value's source is history.
		expect(parsed.metadata).toMatchObject({ revision: 2, basis: "explicit", sources: [second] });
		const records = personaRecords(payloads.at(-1) as WirePayload);
		expect(records.at(-1)).toContain("Give detailed status updates. (explicit)");
		expect(records.at(-1)).not.toContain("Keep status updates short.");

		// Stale update: a replace against an older revision changes nothing.
		await runMemoryTurn(harness, "ok", {
			action: "replace",
			target: "user",
			oldContent: "Give detailed status updates.",
			content: "Never mind.",
			basis: "explicit",
			evidence: [{ source: second, quote: "detailed status updates" }],
			expectedRevision: 1,
		});
		expect(readFileSync(userPath, "utf8")).toContain("Give detailed status updates.");
	});

	it("an inferred workflow pattern needs two independent owner sources; a replayed source, even across compaction and reload, is one", async () => {
		const payloads: WirePayload[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_provider_request", (event) => {
						const payload = event.payload as { systemPrompt?: unknown; messages?: unknown };
						payloads.push({
							systemPrompt: typeof payload.systemPrompt === "string" ? payload.systemPrompt : "",
							messages: Array.isArray(payload.messages) ? (payload.messages as WirePayload["messages"]) : [],
						});
						return undefined;
					});
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary: the owner asked for diffs first",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		await harness.session.initializeMemory();
		const userPath = join(harness.tempDir, "USER.md");
		await runPlainTurn(harness, "Diff first please.");
		const [first] = ownerSources(harness);
		await runMemoryTurn(harness, "ok", {
			action: "add",
			target: "user",
			content: "Shows the diff before the explanation.",
			basis: "inferred",
			evidence: [
				{ source: first, quote: "diff first please" },
				{ source: first, quote: "diff first" },
			],
		});
		expect(readFileSync(userPath, "utf8").trim()).toBe("");
		expect(audits(harness).at(-1)).toMatchObject({ action: "propose", reasonCode: "insufficient_observations" });

		await harness.session.compact();
		await runPlainTurn(harness, "carry on");
		await harness.session.reload();
		await runPlainTurn(harness, "Show me the diff before explaining.");
		const second = ownerSources(harness).at(-1) as string;
		expect(second).not.toBe(first);
		await runMemoryTurn(harness, "ok", {
			action: "add",
			target: "user",
			content: "Shows the diff before the explanation.",
			basis: "inferred",
			evidence: [
				{ source: first, quote: "diff first please" },
				{ source: second, quote: "show me the diff before explaining" },
			],
		});
		const parsed = parseUserPreferenceLine(readFileSync(userPath, "utf8").trim());
		expect(parsed.metadata).toMatchObject({ basis: "inferred", observations: 2, sources: [first, second] });
		expect(personaRecords(payloads.at(-1) as WirePayload).at(-1)).toContain(
			"Shows the diff before the explanation. (inferred, 2 independent observations)",
		);
	});

	it("disabled learning keeps inferred patterns as durable candidates while an explicit owner command still applies", async () => {
		const { harness, userPath } = await createPersonaHarness({
			settings: { learningPolicy: { enabled: false } },
			initializeMemory: true,
		});
		harnesses.push(harness);
		await runPlainTurn(harness, "Diff first please.");
		await runPlainTurn(harness, "Show me the diff before explaining.");
		const [a, b] = ownerSources(harness);
		await runMemoryTurn(harness, "ok", {
			action: "add",
			target: "user",
			content: "Shows the diff before the explanation.",
			basis: "inferred",
			evidence: [
				{ source: a, quote: "diff first please" },
				{ source: b, quote: "show me the diff before explaining" },
			],
		});
		expect(readFileSync(userPath, "utf8").trim()).toBe("");
		expect(audits(harness).at(-1)).toMatchObject({ action: "propose", reasonCode: "learning_disabled" });
		await runPlainTurn(harness, "Remember this: always show the diff first.");
		const c = ownerSources(harness).at(-1) as string;
		await runMemoryTurn(harness, "ok", {
			action: "add",
			target: "user",
			content: "Shows the diff first.",
			basis: "explicit",
			evidence: [{ source: c, quote: "always show the diff first" }],
		});
		expect(parseUserPreferenceLine(readFileSync(userPath, "utf8").trim()).metadata).toMatchObject({
			basis: "explicit",
		});
	});

	it("a project-scoped choice is tagged with this project's key and delivered here", async () => {
		const { harness, payloads, userPath } = await createPersonaHarness({ initializeMemory: true });
		harnesses.push(harness);
		await runPlainTurn(harness, "In this repo, remember this: always run the fast shard first.");
		const [source] = ownerSources(harness);
		await runMemoryTurn(harness, "ok", {
			action: "add",
			target: "user",
			content: "Runs the fast test shard first.",
			scope: "project",
			basis: "explicit",
			evidence: [{ source, quote: "always run the fast shard first" }],
		});
		const parsed = parseUserPreferenceLine(readFileSync(userPath, "utf8").trim());
		expect(parsed.metadata?.scope.kind).toBe("project");
		expect(personaRecords(payloads.at(-1) as WirePayload).at(-1)).toContain(
			"Runs the fast test shard first. (explicit)",
		);
	});

	it("owner evidence is the owner's original words: a prompt template expansion is not owner testimony", async () => {
		const loader = createTestResourceLoader();
		loader.getPrompts = () => ({
			prompts: [
				{
					name: "verbose",
					description: "test template",
					content: "Remember this: always use verbose logs.",
					sourceInfo: { source: "test", type: "prompt" },
					filePath: "/tmp/verbose.md",
				} as never,
			],
			diagnostics: [],
		});
		const harness = await createHarness({ resourceLoader: loader });
		harnesses.push(harness);
		await harness.session.initializeMemory();
		await runPlainTurn(harness, "/verbose");
		const [message] = harness.session.messages.filter((candidate) => candidate.role === "user");
		expect(messageText(message as { content: unknown })).toContain("always use verbose logs");
		const evidence = getOwnerEvidenceSnapshots(harness.sessionManager.getEntries());
		expect(evidence.map((entry) => entry.text)).toEqual(["/verbose"]);
	});

	it("withdrawn queued input never becomes evidence", async () => {
		const { harness } = await createPersonaHarness({ initializeMemory: true });
		harnesses.push(harness);
		await harness.session.steer("Remember this: never use tabs.");
		expect(harness.session.pendingMessageCount).toBe(1);
		harness.session.clearQueue();
		await runPlainTurn(harness, "hello");
		expect(getOwnerEvidenceSnapshots(harness.sessionManager.getEntries()).map((entry) => entry.text)).toEqual([
			"hello",
		]);
	});

	it("a live in-process worker receives the current owner preferences in its system prompt", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-model", contextWindow: 128_000 }],
			initialActiveToolNames: ["read", "delegate"],
			settings: { workerDelegation: { enabled: true } },
		});
		harnesses.push(harness);
		await harness.session.initializeMemory();
		const seen: string[] = [];
		const workerJson =
			'{"summary":"Repository layout summarized.","status":"completed","findings":[{"summary":"src holds the core","confidence":0.8}]}';
		harness.setResponses([
			(context) => {
				seen.push(context.systemPrompt ?? "");
				return fauxAssistantMessage(workerJson);
			},
		]);
		const before = await harness.session.runWorkerDelegationOnce({
			instructions: "Summarize the repository layout.",
			profileId: "test-worker",
		});
		expect(before.started, JSON.stringify(before)).toBe(true);
		expect(seen).toHaveLength(1);
		expect(seen[0]).not.toContain("OWNER WORKING PREFERENCES");
		// The worker's terminal handoff is delivered to the foreground as an internal turn; wait it out.
		await waitForIdle(harness);

		const source = await ownerSays(harness, "Remember this: keep status updates short.");
		await runMemoryTurn(harness, "ok", {
			action: "add",
			target: "user",
			content: "Keep status updates short.",
			basis: "explicit",
			evidence: [{ source, quote: "keep status updates short" }],
		});
		// The memory write buys one detached reflection turn on the root; let it settle so the next
		// captured provider request is the worker's, not the root's.
		await harness.session.settleReflectionTurn();
		await waitForIdle(harness);
		seen.length = 0;
		harness.setResponses([
			(context) => {
				seen.push(context.systemPrompt ?? "");
				return fauxAssistantMessage(workerJson);
			},
		]);
		const after = await harness.session.runWorkerDelegationOnce({
			instructions: "Summarize the repository layout again.",
			profileId: "test-worker",
		});
		expect(after.started, JSON.stringify(after)).toBe(true);
		const workerPrompts = seen.filter((prompt) => !prompt.startsWith("Pi-Adaptative"));
		expect(workerPrompts, JSON.stringify(seen.map((prompt) => prompt.slice(0, 40)))).toHaveLength(1);
		expect(workerPrompts[0]).toContain("OWNER WORKING PREFERENCES (guidance, not grants)");
		expect(workerPrompts[0]).toContain("- Keep status updates short. (explicit)");
		// Negative control: the root's own prompt is not the delivery channel for the worker.
		for (const prompt of seen.filter((candidate) => candidate.startsWith("Pi-Adaptative"))) {
			expect(prompt).not.toContain("OWNER WORKING PREFERENCES");
		}
	});
});
