import { describe, expect, it } from "vitest";
import { formatModelFitnessReport, runModelFitnessProbe } from "../src/core/research/model-fitness.ts";

/**
 * Local-model size-class bench: probes locally-installed models (via Ollama) through the
 * committed model-fitness probe with size-class-appropriate minimum bars.
 *
 * OPT-IN ONLY: runs when PI_LOCAL_MODEL_BENCH=1 and a local Ollama responds — CI and default
 * test runs skip it entirely. Uses only local/free inference, no credentials or paid tokens.
 *
 * Configure candidates via PI_LOCAL_MODEL_BENCH_MODELS as comma-separated `class:ref` pairs, e.g.
 *   PI_LOCAL_MODEL_BENCH_MODELS="nano:qwen3:0.6b,small:hf.co/prism-ml/Bonsai-1.7B-gguf:Q1_0"
 * Classes: nano (<1B), small (1-3B), medium-local (3-9B).
 */
const ENABLED = process.env.PI_LOCAL_MODEL_BENCH === "1";
const OLLAMA = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const TRIALS = 3;

type SizeClass = "nano" | "small" | "medium-local";

interface BenchCandidate {
	sizeClass: SizeClass;
	ref: string;
}

function parseCandidates(raw: string | undefined): BenchCandidate[] {
	if (!raw) return [];
	const candidates: BenchCandidate[] = [];
	for (const entry of raw.split(",")) {
		const trimmed = entry.trim();
		const separator = trimmed.indexOf(":");
		if (separator <= 0) continue;
		const sizeClass = trimmed.slice(0, separator);
		const ref = trimmed.slice(separator + 1);
		if ((sizeClass === "nano" || sizeClass === "small" || sizeClass === "medium-local") && ref.length > 0) {
			candidates.push({ sizeClass, ref });
		}
	}
	return candidates;
}

const CANDIDATES = parseCandidates(process.env.PI_LOCAL_MODEL_BENCH_MODELS);

async function ollamaReachable(): Promise<boolean> {
	if (!ENABLED || CANDIDATES.length === 0) return false;
	try {
		const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2000) });
		return res.ok;
	} catch {
		return false;
	}
}

function completeFor(model: string) {
	return async (args: { systemPrompt: string; userPrompt: string; signal?: AbortSignal }) => {
		const request = (withThinkFlag: boolean) =>
			fetch(`${OLLAMA}/api/chat`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				signal: args.signal,
				body: JSON.stringify({
					model,
					messages: [
						{ role: "system", content: args.systemPrompt },
						{ role: "user", content: args.userPrompt },
					],
					stream: false,
					...(withThinkFlag ? { think: false } : {}),
					options: { temperature: 0.2, num_predict: 768 },
				}),
			});
		let res = await request(true);
		if (!res.ok) res = await request(false);
		if (!res.ok) throw new Error(`ollama http ${res.status}`);
		const data = (await res.json()) as {
			message?: { content?: string };
			eval_count?: number;
			eval_duration?: number;
		};
		let text = data.message?.content ?? "";
		const thinkEnd = text.indexOf("</think>");
		if (thinkEnd >= 0) text = text.slice(thinkEnd + "</think>".length);
		return {
			text,
			costUsd: 0,
			stopReason: "stop",
			outputTokens: data.eval_count,
			evalMs: data.eval_duration !== undefined ? data.eval_duration / 1e6 : undefined,
		};
	};
}

const HONEST_OUTCOME_RE = /^(succeeded|failed|canceled|timeout|budget_exhausted|completed|blocked|cancelled)\//;

const runnable = await ollamaReachable();

describe.skipIf(!runnable)("local model size-class bench", () => {
	for (const candidate of CANDIDATES) {
		it(
			`${candidate.sizeClass} ${candidate.ref} meets its class bars`,
			async () => {
				const report = await runModelFitnessProbe({ trials: TRIALS, complete: completeFor(candidate.ref) });
				console.log(formatModelFitnessReport(`${candidate.sizeClass} ${candidate.ref}`, report));

				// Universal bar (every class): the probe machinery itself never produces dishonest
				// outcomes — every lane outcome is a known status/reason pair.
				for (const outcome of [...report.research.outcomes, ...report.worker.outcomes]) {
					expect(outcome).toMatch(HONEST_OUTCOME_RE);
				}

				if (candidate.sizeClass === "small") {
					expect(report.research.succeeded).toBeGreaterThanOrEqual(1);
					expect(report.toolCall.succeeded).toBeGreaterThanOrEqual(1);
				}
				if (candidate.sizeClass === "medium-local") {
					expect(report.research.succeeded).toBeGreaterThanOrEqual(2);
					expect(report.worker.succeeded).toBeGreaterThanOrEqual(2);
					expect(report.judge.parsed).toBeGreaterThanOrEqual(4);
				}
			},
			30 * 60_000,
		);
	}
});

describe.skipIf(runnable)("local model bench (skipped)", () => {
	it("requires PI_LOCAL_MODEL_BENCH=1, PI_LOCAL_MODEL_BENCH_MODELS, and a reachable local Ollama", () => {
		expect(runnable).toBe(false);
	});
});
