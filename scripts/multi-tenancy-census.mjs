#!/usr/bin/env node
/**
 * Multi-tenancy census over recorded sessions and worker conversations: how many provider requests
 * were in flight machine-wide when each request started, how time to first token moved with that,
 * every automatic retry by provider account and reason, every admission wait by reason, and the
 * one property the shared limit state exists to guarantee: a rate limit one process learned is not
 * rediscovered by another. `--gate` fails when it is.
 *
 *   node scripts/multi-tenancy-census.mjs <dir>... [--since <iso|days>] [--gate '{...}'] [--json]
 *
 * Reads `~/.pi/agent/sessions` and `~/.pi/agent/state/orchestration/**\/worker-conversations` (or
 * the directories given). Requests are joined `request_snapshot.timestamp` -> assistant
 * `firstTokenAt`/`streamEndAt`; a worker conversation without snapshots uses the previous
 * user/toolResult timestamp. Never writes.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_GATE = {
	/** Two processes discovering the same account's rate limit within this window is a rediscovery. */
	rediscoveryWindowMs: 5_000,
	maxRateLimitRediscoveries: 0,
	/** Waits that hit the budget and proceeded anyway. */
	maxTimedOutWaits: 0,
};

function toMs(value) {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "number") return value > 1e11 ? value : value * 1000;
	const parsed = Date.parse(String(value));
	return Number.isFinite(parsed) ? parsed : undefined;
}

function accountKey(record) {
	return record.account ? `${record.provider}#${record.account}` : record.provider;
}

export function quantile(values, q) {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

/** Fold one session's entries (in order) into request rows, retry records and wait records. */
export function censusEntries(entries, source) {
	const requests = [];
	const retries = [];
	const waits = [];
	let snapshotAt;
	let lastInputAt;
	for (const entry of entries) {
		const at = toMs(entry.timestamp);
		if (entry.type === "request_snapshot") snapshotAt = at;
		if (entry.type === "custom" && entry.customType === "provider_retry" && entry.data) {
			retries.push({ ...entry.data, at, source });
			continue;
		}
		if (entry.type === "custom" && entry.customType === "provider_admission" && entry.data) {
			waits.push({ ...entry.data, at, source });
			continue;
		}
		const message = entry.type === "message" ? entry.message : undefined;
		if (!message) continue;
		if (message.role === "user" || message.role === "toolResult") lastInputAt = at;
		if (message.role !== "assistant") continue;
		const start = snapshotAt ?? lastInputAt;
		const first = toMs(message.firstTokenAt);
		const end = toMs(message.streamEndAt) ?? at;
		snapshotAt = undefined;
		if (start === undefined || end === undefined || (at !== undefined && start > at + 1000)) continue;
		requests.push({
			source,
			provider: message.provider,
			start,
			first,
			end,
			output: message.usage?.output ?? 0,
			stopReason: message.stopReason,
		});
	}
	return { requests, retries, waits };
}

export function summarize(folded) {
	const requests = folded.flatMap((f) => f.requests);
	const retries = folded.flatMap((f) => f.retries);
	const waits = folded.flatMap((f) => f.waits);
	const byProvider = new Map();
	for (const request of requests) {
		const list = byProvider.get(request.provider) ?? [];
		list.push(request);
		byProvider.set(request.provider, list);
	}
	const providers = {};
	for (const [provider, list] of byProvider) {
		const byInflight = {};
		for (const request of list) {
			const others = list.filter((r) => r !== request && r.start <= request.start && request.start < r.end).length;
			const bucket = Math.min(others, 3);
			const key = bucket === 3 ? "3+" : String(bucket);
			if (request.first !== undefined && request.first >= request.start) {
				(byInflight[key] ??= []).push((request.first - request.start) / 1000);
			}
		}
		providers[provider] = {
			requests: list.length,
			ttftByOtherInflight: Object.fromEntries(
				Object.entries(byInflight).map(([key, values]) => [
					key,
					{ n: values.length, p50: quantile(values, 0.5), p90: quantile(values, 0.9) },
				]),
			),
		};
	}
	const retriesByAccount = {};
	for (const retry of retries) {
		if (retry.phase !== "start") continue;
		const key = `${retry.provider ?? "?"}${retry.modelId ? `/${retry.modelId}` : ""}`;
		const reason = /rate.?limit|429/i.test(retry.errorMessage ?? "")
			? "rate_limit"
			: /overloaded/i.test(retry.errorMessage ?? "")
				? "overloaded"
				: "other";
		((retriesByAccount[key] ??= {})[reason] ??= 0);
		retriesByAccount[key][reason] += 1;
	}
	const waitsByReason = {};
	for (const wait of waits) {
		const bucket = (waitsByReason[wait.reason ?? "capacity"] ??= { n: 0, totalWaitedMs: 0, timedOut: 0 });
		bucket.n += 1;
		bucket.totalWaitedMs += wait.waitedMs ?? 0;
		if (wait.timedOut) bucket.timedOut += 1;
	}
	return { requests: requests.length, providers, retriesByAccount, waitsByReason, retries, waits };
}

/**
 * Rate-limit retries from DIFFERENT sources on the same provider within the window: with the
 * shared limit state working, the second process should have waited on the record instead of
 * sending a request that got refused.
 */
export function rateLimitRediscoveries(retries, windowMs) {
	const starts = retries
		.filter((r) => r.phase === "start" && r.at !== undefined && /rate.?limit|429/i.test(r.errorMessage ?? ""))
		.sort((a, b) => a.at - b.at);
	const found = [];
	for (let i = 0; i < starts.length; i++) {
		for (let j = i + 1; j < starts.length && starts[j].at - starts[i].at <= windowMs; j++) {
			if (starts[i].provider === starts[j].provider && starts[i].source !== starts[j].source) {
				found.push({ provider: starts[i].provider, at: starts[i].at, sources: [starts[i].source, starts[j].source] });
			}
		}
	}
	return found;
}

export function evaluateGate(summary, gate = DEFAULT_GATE) {
	const failures = [];
	const rediscoveries = rateLimitRediscoveries(summary.retries, gate.rediscoveryWindowMs);
	if (rediscoveries.length > gate.maxRateLimitRediscoveries) {
		failures.push(
			`${rediscoveries.length} rate-limit rediscoveries across processes (max ${gate.maxRateLimitRediscoveries}): ` +
				rediscoveries
					.slice(0, 5)
					.map((r) => `${r.provider} at ${new Date(r.at).toISOString()} by ${r.sources.join(" and ")}`)
					.join("; "),
		);
	}
	const timedOut = Object.values(summary.waitsByReason).reduce((sum, bucket) => sum + bucket.timedOut, 0);
	if (timedOut > gate.maxTimedOutWaits) failures.push(`${timedOut} admission waits timed out (max ${gate.maxTimedOutWaits})`);
	return { ok: failures.length === 0, failures, rediscoveries };
}

async function* walkJsonl(dir) {
	let names;
	try {
		names = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of names) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) yield* walkJsonl(full);
		else if (entry.name.endsWith(".jsonl")) yield full;
	}
}

export async function runCensus(dirs, { sinceMs } = {}) {
	const folded = [];
	for (const dir of dirs) {
		for await (const file of walkJsonl(dir)) {
			if (sinceMs !== undefined) {
				const info = await stat(file);
				if (info.mtimeMs < sinceMs) continue;
			}
			const text = await readFile(file, "utf8");
			const entries = [];
			for (const line of text.split("\n")) {
				if (!line.trim()) continue;
				try {
					entries.push(JSON.parse(line));
				} catch {
					// A torn line is not a request.
				}
			}
			folded.push(censusEntries(entries, path.basename(file, ".jsonl")));
		}
	}
	return summarize(folded);
}

function formatReport(summary, gate) {
	const lines = [`Multi-tenancy census — ${summary.requests} provider requests`];
	for (const [provider, info] of Object.entries(summary.providers).sort()) {
		lines.push(`  ${provider}: ${info.requests} requests; TTFT by other requests in flight at start:`);
		for (const [key, q] of Object.entries(info.ttftByOtherInflight).sort()) {
			lines.push(`    ${key.padEnd(2)} n=${String(q.n).padStart(5)} p50=${q.p50.toFixed(1)}s p90=${q.p90.toFixed(1)}s`);
		}
	}
	lines.push("Automatic retries by model and reason:");
	for (const [key, reasons] of Object.entries(summary.retriesByAccount).sort()) {
		lines.push(`  ${key}: ${Object.entries(reasons).map(([reason, n]) => `${reason}=${n}`).join(" ")}`);
	}
	if (Object.keys(summary.retriesByAccount).length === 0) lines.push("  none recorded");
	lines.push("Admission waits by reason:");
	for (const [reason, bucket] of Object.entries(summary.waitsByReason).sort()) {
		lines.push(`  ${reason}: n=${bucket.n} total=${(bucket.totalWaitedMs / 1000).toFixed(1)}s timedOut=${bucket.timedOut}`);
	}
	if (Object.keys(summary.waitsByReason).length === 0) lines.push("  none recorded");
	const verdict = evaluateGate(summary, gate);
	lines.push(verdict.ok ? "Gate: ok" : `Gate: FAILED\n  ${verdict.failures.join("\n  ")}`);
	return { text: lines.join("\n"), verdict };
}

async function main(argv) {
	const dirs = [];
	let gate = DEFAULT_GATE;
	let sinceMs;
	let json = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--gate") gate = { ...DEFAULT_GATE, ...JSON.parse(argv[++i] ?? "{}") };
		else if (arg === "--since") {
			const raw = argv[++i];
			sinceMs = /^\d+$/.test(raw) ? Date.now() - Number(raw) * 86_400_000 : Date.parse(raw);
		} else if (arg === "--json") json = true;
		else dirs.push(arg);
	}
	if (dirs.length === 0) {
		const agentDir = process.env.PI_AGENT_DIR ?? path.join(homedir(), ".pi", "agent");
		dirs.push(path.join(agentDir, "sessions"), path.join(agentDir, "state", "orchestration"));
	}
	const summary = await runCensus(dirs, { sinceMs });
	const { text, verdict } = formatReport(summary, gate);
	if (json) console.log(JSON.stringify({ ...summary, retries: undefined, waits: undefined, gate: verdict }, null, 2));
	else console.log(text);
	process.exitCode = verdict.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main(process.argv.slice(2));
}
