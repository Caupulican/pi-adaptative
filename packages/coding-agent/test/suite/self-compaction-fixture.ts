import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { expect } from "vitest";
import {
	SELF_COMPACT_TOOL_NAME,
	SELF_COMPACTION_HANDOFF_CUSTOM_TYPE,
} from "../../src/core/compaction/self-compaction.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

export const NOTE = "Goal: finish the report\nDone: read notes.md\nNEXT ACTION: write summary.md";
export interface SessionFileLine {
	type?: string;
	customType?: string;
	message?: { role?: string };
}

export const MODELS = [{ id: "faux-window", contextWindow: 200_000 }];
export const SETTINGS = { compaction: { reserveTokens: 4_000, keepRecentTokens: 2_000 } };

export function reply(...args: Parameters<typeof fauxAssistantMessage>): FauxResponseStep {
	return () => fauxAssistantMessage(...args);
}

function isSummaryRequest(context: Parameters<Extract<FauxResponseStep, (...args: never[]) => unknown>>[0]): boolean {
	const last = JSON.stringify(context.messages.at(-1) ?? "");
	return (context.systemPrompt ?? "").startsWith("Context checkpointer") || last.includes("checkpoint");
}

export function script(harness: Harness, turns: FauxResponseStep[]): { summaries: number } {
	const counts = { summaries: 0 };
	const queue = [...turns];
	const dispatch: FauxResponseStep = (context, options, state, model) => {
		if (isSummaryRequest(context)) {
			counts.summaries++;
			return fauxAssistantMessage("## Goal\nsummary of the earlier work");
		}
		const next = queue.shift() ?? reply("idle");
		return typeof next === "function" ? next(context, options, state, model) : next;
	};
	harness.setResponses(Array.from({ length: 40 }, () => dispatch));
	return counts;
}

export function filler(tokens: number): string {
	return "lorem ipsum dolor sit amet ".repeat(Math.ceil((tokens * 4) / 27));
}

export function handoffSettled(harness: Harness): Promise<void> {
	return new Promise((resolve) => {
		const off = harness.session.nativeActivity.subscribePendingContinuation(() => {
			if (!harness.session.nativeActivity.isSettled()) return;
			off();
			resolve();
		});
	});
}

export function entriesOf(harness: Harness, customType: string) {
	return harness.sessionManager
		.getEntries()
		.filter(
			(entry) => (entry.type === "custom" || entry.type === "custom_message") && entry.customType === customType,
		);
}

export function handoffNotes(harness: Harness): (string | undefined)[] {
	return entriesOf(harness, SELF_COMPACTION_HANDOFF_CUSTOM_TYPE).map((entry) =>
		entry.type === "custom_message" && typeof entry.content === "string" ? entry.content : undefined,
	);
}

export function createSelfCompactionSessions() {
	const harnesses: Harness[] = [];

	async function open(options: Partial<HarnessOptions> = {}): Promise<Harness> {
		const harness = await createHarness({ models: MODELS, settings: SETTINGS, ...options });
		harnesses.push(harness);
		return harness;
	}

	async function sessionAtWarning(options: Partial<HarnessOptions> = {}, level = "warning"): Promise<Harness> {
		const harness = await open(options);
		script(harness, [reply("noted")]);
		await harness.session.prompt("hello");
		const view = harness.session.getSelfCompactionView();
		expect(view.thresholds).not.toBeNull();
		const chunk = Math.ceil(view.thresholds!.warningTokens / 16);
		for (let turn = 0; turn < 40 && harness.session.getSelfCompactionView().level !== level; turn++) {
			script(harness, [reply(`noted ${turn}`)]);
			await harness.session.prompt(`context ${turn}: ${filler(chunk)}`);
		}
		expect(harness.session.getSelfCompactionView().level).toBe(level);
		return harness;
	}

	async function savedNoteWithoutHandoff(harness: Harness): Promise<void> {
		script(harness, [
			reply([fauxToolCall(SELF_COMPACT_TOOL_NAME, { note_to_self: NOTE })], { stopReason: "toolUse" }),
		]);
		const internals = harness.session as unknown as { _selfCompaction: { schedule(): boolean } };
		const schedule = internals._selfCompaction.schedule.bind(internals._selfCompaction);
		internals._selfCompaction.schedule = () => false;
		await harness.session.prompt("wrap up");
		internals._selfCompaction.schedule = schedule;
		expect(harness.session.getSelfCompactionView().handoff.status).toBe("pending");
	}

	async function reopen(previous: Harness): Promise<Harness> {
		const sessionFile = previous.sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		await previous.session.disposeAndWait();
		return open({ sessionFile, agentDir: previous.tempDir, cwd: previous.tempDir });
	}

	async function crashImage(
		previous: Harness,
		cutAfter: (entry: SessionFileLine, index: number, lines: SessionFileLine[]) => boolean,
	) {
		const sessionFile = previous.sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		await previous.session.disposeAndWait();
		const raw = readFileSync(sessionFile!, "utf8")
			.split("\n")
			.filter((line) => line.length > 0);
		const lines = raw.map((line) => JSON.parse(line) as SessionFileLine);
		const cut = lines.findIndex((entry, index) => cutAfter(entry, index, lines));
		expect(cut).toBeGreaterThan(0);
		const image = join(previous.tempDir, "crash-image.jsonl");
		writeFileSync(image, `${raw.slice(0, cut + 1).join("\n")}\n`);
		return open({ sessionFile: image, agentDir: previous.tempDir, cwd: previous.tempDir });
	}

	const isHandoffLine = (entry: SessionFileLine) =>
		entry.type === "custom_message" && entry.customType === SELF_COMPACTION_HANDOFF_CUSTOM_TYPE;

	async function answeredHandoff(continuation: FauxResponseStep[]): Promise<Harness> {
		const harness = await sessionAtWarning({ persistSession: true });
		script(harness, [
			reply([fauxToolCall(SELF_COMPACT_TOOL_NAME, { note_to_self: NOTE })], { stopReason: "toolUse" }),
			...continuation,
		]);
		const done = handoffSettled(harness);
		await harness.session.prompt("wrap up");
		await done;
		expect(harness.session.getSelfCompactionView().handoff.status).toBe("answered");
		return harness;
	}

	async function cleanup(): Promise<void> {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	}

	return {
		open,
		sessionAtWarning,
		savedNoteWithoutHandoff,
		reopen,
		crashImage,
		isHandoffLine,
		answeredHandoff,
		cleanup,
	};
}
