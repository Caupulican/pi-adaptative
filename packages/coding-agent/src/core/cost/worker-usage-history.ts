import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Usage } from "@caupulican/pi-ai";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import { isValidSessionId } from "../../kernel/session/session-identity.ts";
import { visitSessionEntriesAsync } from "../../kernel/session/session-manager.ts";
import { assertWorkerConversationFile } from "../../kernel/session/worker-storage-identity.ts";
import { FileSnapshotChangedError } from "../../kernel/storage/bounded-file.ts";
import { addUsage, createEmptyUsage, getSessionEntryUsageComponents } from "../../kernel/usage.ts";
import { scanWorkerSessionFile } from "../delegation/worker-conversation-revision.ts";
import { providerUsageFromAttemptUsage, validateProviderUsage } from "../orchestration/attempt-usage.ts";
import { OrchestrationEventStore } from "../orchestration/event-store.ts";
import { isMissingFileError } from "../util/atomic-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import type {
	AccountingEvidenceGroup,
	AccountingSourceRevision,
	AccountingUsageComponent,
} from "./accounting-evidence.ts";
import {
	getSpawnedUsageComponents,
	resolveSemanticUsageEntry,
	SPAWNED_USAGE_CUSTOM_TYPE,
	type SpawnedUsageReport,
} from "./usage-records.ts";
import {
	type HistoricalWorkerAccountingState,
	type HistoricalWorkerAttempt,
	readHistoricalWorkerAccountingState,
} from "./worker-accounting-state.ts";

type Source = {
	evidence: AccountingSourceRevision;
	unchanged(): Promise<boolean>;
};

/** Capture exact source bytes without retaining the transcript or changing its owner. */
async function captureSource(path: string): Promise<Source> {
	const file = await open(path, "r");
	try {
		const before = await file.stat({ bigint: true });
		const same = (after: typeof before) =>
			before.dev === after.dev &&
			before.ino === after.ino &&
			before.size === after.size &&
			before.mtimeNs === after.mtimeNs &&
			before.ctimeNs === after.ctimeNs;
		if (!before.isFile()) throw new Error(`Accounting source is not a file: ${path}`);
		const hash = createHash("sha256");
		const buffer = Buffer.allocUnsafe(64 * 1024);
		let offset = 0;
		while (true) {
			const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
			if (!bytesRead) break;
			hash.update(buffer.subarray(0, bytesRead));
			offset += bytesRead;
		}
		if (!same(await file.stat({ bigint: true })) || !same(await stat(path, { bigint: true })))
			throw new FileSnapshotChangedError(`Accounting source changed while reading: ${path}`);
		return {
			evidence: { path, sha256: hash.digest("hex"), size: offset },
			unchanged: async () => {
				try {
					return same(await stat(path, { bigint: true }));
				} catch (error) {
					if (isMissingFileError(error)) return false;
					throw error;
				}
			},
		};
	} finally {
		await file.close();
	}
}

async function eventSourcePaths(store: OrchestrationEventStore): Promise<string[]> {
	const files: string[] = [];
	for (const directory of [store.eventsDir, store.snapshotsDir]) {
		try {
			for (const name of await readdir(directory)) if (/^\d+\.json$/.test(name)) files.push(join(directory, name));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	for (const path of [store.baselinePath, store.cursorPath]) {
		try {
			await stat(path);
			files.push(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return files.sort();
}

function attemptForReport(
	reportId: string,
	sessionId: string,
	state: HistoricalWorkerAccountingState,
): HistoricalWorkerAttempt | undefined {
	const prefix = `worker-usage:${sessionId}:`;
	if (reportId.startsWith(prefix)) {
		const identity = reportId.slice(prefix.length);
		const separator = identity.lastIndexOf(":");
		return separator > 0 ? state.attempts.get(identity.slice(0, separator)) : undefined;
	}
	if (reportId.startsWith("managed-worker:")) return state.attempts.get(reportId.slice("managed-worker:".length));
	const legacy = `worker:${sessionId}:`;
	if (!reportId.startsWith(legacy)) return undefined;
	const attempts = [...state.attempts.values()].filter((attempt) => attempt.taskId === reportId.slice(legacy.length));
	return attempts.length === 1 ? attempts[0] : undefined;
}

function sameTotals(left: Usage, right: Usage): boolean {
	return (
		["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every(
			(field) =>
				left[field as keyof Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens">] ===
				right[field as keyof Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens">],
		) && Math.abs(left.cost.total - right.cost.total) <= Math.max(1e-9, Number.EPSILON * Math.abs(left.cost.total))
	);
}

async function readTranscript(
	path: string,
	sessionId: string,
	cwd: string,
): Promise<{ byAttempt: Map<string, AccountingUsageComponent[]>; source: Source }> {
	const source = await captureSource(path);
	let head: ReturnType<typeof scanWorkerSessionFile>;
	try {
		head = scanWorkerSessionFile(path, sessionId, cwd);
	} catch (error) {
		if (!(await source.unchanged()))
			throw new FileSnapshotChangedError("Worker accounting source changed during verification.");
		throw error;
	}
	const byAttempt = new Map<string, AccountingUsageComponent[]>();
	let attemptId = "";
	let visited = 0;
	const seenReports = new Set<string>();
	await visitSessionEntriesAsync(
		path,
		() => true,
		(entry) => {
			visited++;
			if (entry.type === "custom" && entry.customType === "worker-attempt-usage-boundary") {
				if (!isPlainRecord(entry.data) || typeof entry.data.attemptId !== "string")
					throw new Error("Worker accounting boundary has no attempt identity.");
				attemptId = JSON.stringify([entry.data.parentSessionId ?? null, entry.data.attemptId]);
				if (byAttempt.has(attemptId)) throw new Error("Worker accounting boundary repeats an attempt identity.");
				byAttempt.set(attemptId, []);
				return;
			}
			const semantic = resolveSemanticUsageEntry(entry);
			const spawned =
				entry.type === "custom" && entry.customType === SPAWNED_USAGE_CUSTOM_TYPE
					? (entry.data as SpawnedUsageReport)
					: undefined;
			const reportId = semantic?.report.reportId ?? spawned?.reportId;
			if (reportId) {
				const key = `${entry.type === "custom" ? entry.customType : ""}:${reportId}`;
				if (seenReports.has(key)) return;
				seenReports.add(key);
			}
			const parts = semantic
				? [
						{
							usage: semantic.report.usage,
							provider: semantic.report.provider,
							model: semantic.report.model,
							timestamp: semantic.report.responseTimestamp ?? entry.timestamp,
							sourceId: semantic.report.reportId,
						},
					]
				: spawned
					? getSpawnedUsageComponents(spawned, entry.timestamp)
					: getSessionEntryUsageComponents(entry);
			if (parts.length === 0) return;
			const message = entry.type === "message" ? entry.message : undefined;
			const details = message?.role === "toolResult" && isPlainRecord(message.details) ? message.details : undefined;
			const provenance = details && isPlainRecord(details.costProvenance) ? details.costProvenance : undefined;
			const components = byAttempt.get(attemptId) ?? [];
			const operation =
				entry.type === "compaction" || entry.type === "branch_summary"
					? entry.type
					: semantic?.report.route === "compaction" || semantic?.report.route === "branch_summary"
						? semantic.report.route
						: undefined;
			for (const part of parts) {
				const provider = part.provider ?? provenance?.provider;
				const model = part.model ?? provenance?.model;
				components.push({
					usage: validateProviderUsage(part.usage),
					timestamp: part.timestamp,
					sourceId: `${sessionId}:${part.sourceId}`,
					...(operation ? { operation } : {}),
					...(typeof provider === "string" ? { provider } : {}),
					...(typeof model === "string" ? { model } : {}),
				});
			}
			byAttempt.set(attemptId, components);
		},
	);
	if (!(await source.unchanged()))
		throw new FileSnapshotChangedError("Worker accounting transcript changed while reading.");
	if (visited !== head.entryCount) throw new Error("Worker accounting transcript contains unreadable entries.");
	return { byAttempt, source };
}

/**
 * Recover worker accounting through exact durable attempt identities. Transcript components replace
 * parent rollups only after conservation of every token category and the originally reported dollars.
 * Reading the existing store never creates a runtime, publishes receipts or compacts its history.
 */
export async function collectWorkerAccountingEvidence(
	agentDir: string,
	sessionId: string,
	entries: readonly SessionEntry[],
): Promise<AccountingEvidenceGroup[]> {
	const byOrigin = new Map<string, SessionEntry[]>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== SPAWNED_USAGE_CUSTOM_TYPE || !isPlainRecord(entry.data))
			continue;
		const reportId = entry.data.reportId;
		const recordedParent =
			typeof reportId === "string" ? /^worker(?:-usage)?:([^:]+):/.exec(reportId)?.[1] : undefined;
		const parent = recordedParent && isValidSessionId(recordedParent) ? recordedParent : sessionId;
		const owned = byOrigin.get(parent) ?? [];
		owned.push(entry);
		byOrigin.set(parent, owned);
	}
	const groups = await collectSessionWorkerEvidence(agentDir, sessionId, byOrigin.get(sessionId) ?? [], true);
	for (const [parent, inherited] of byOrigin) {
		if (parent !== sessionId)
			groups.push(...(await collectSessionWorkerEvidence(agentDir, parent, inherited, false)));
	}
	const grouped = new Set(groups.flatMap((group) => group.reportIds));
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== SPAWNED_USAGE_CUSTOM_TYPE || !isPlainRecord(entry.data))
			continue;
		const reportId = entry.data.reportId;
		if (typeof reportId !== "string" || !reportId.startsWith(`route-judge:${sessionId}:`) || grouped.has(reportId))
			continue;
		grouped.add(reportId);
		groups.push({
			reportIds: [reportId],
			origin: { sessionId, entryId: entry.id, operationId: reportId },
			evidence: [],
			diagnostic: "Retired routing operation: original charge retained; no source model identity is recorded.",
		});
	}
	return groups;
}

async function collectSessionWorkerEvidence(
	agentDir: string,
	sessionId: string,
	entries: readonly SessionEntry[],
	includePending: boolean,
): Promise<AccountingEvidenceGroup[]> {
	const reports = new Map<string, Usage>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== SPAWNED_USAGE_CUSTOM_TYPE || !isPlainRecord(entry.data))
			continue;
		const { reportId, usage } = entry.data;
		if (typeof reportId !== "string") continue;
		const parsed = validateProviderUsage(usage);
		const previous = reports.get(reportId);
		if (previous && !sameTotals(previous, parsed)) throw new Error("Conflicting historical worker usage identity.");
		reports.set(reportId, parsed);
	}
	const store = new OrchestrationEventStore({ agentDir, sessionId });
	const paths = await eventSourcePaths(store);
	const sources: Source[] = [];
	let state: HistoricalWorkerAccountingState;
	try {
		for (const path of paths) sources.push(await captureSource(path));
		state = readHistoricalWorkerAccountingState(store);
	} catch (error) {
		if (
			JSON.stringify(paths) !== JSON.stringify(await eventSourcePaths(store)) ||
			!(await Promise.all(sources.map((source) => source.unchanged()))).every(Boolean)
		)
			throw new FileSnapshotChangedError("Worker accounting source inventory changed while reading its state.");
		throw error;
	}
	const pending = new Map<string, { reportId: string; usage: Usage; timestamp: string }>();
	for (const attempt of state.attempts.values()) {
		if (!includePending) break;
		for (const receipt of attempt.usageReceipts.values()) {
			const reportId =
				receipt.kind === "baseline"
					? `worker:${sessionId}:${attempt.taskId}`
					: `worker-usage:${sessionId}:${attempt.attemptId}:${receipt.receiptId}`;
			if (reports.has(reportId)) continue;
			const usage = providerUsageFromAttemptUsage(receipt.usage);
			reports.set(reportId, usage);
			pending.set(reportId, { reportId, usage, timestamp: receipt.recordedAt });
		}
	}
	const byAttempt = new Map<string, { attempt: HistoricalWorkerAttempt; reportIds: string[]; usage: Usage }>();
	for (const [reportId, usage] of reports) {
		const attempt = attemptForReport(reportId, sessionId, state);
		if (!attempt) continue;
		let group = byAttempt.get(attempt.attemptId);
		if (!group) {
			group = { attempt, reportIds: [], usage: createEmptyUsage() };
			byAttempt.set(attempt.attemptId, group);
		}
		group.reportIds.push(reportId);
		addUsage(group.usage, usage);
	}
	const transcripts = new Map<string, Awaited<ReturnType<typeof readTranscript>>>();
	const groups: AccountingEvidenceGroup[] = [];
	for (const { attempt, reportIds, usage } of byAttempt.values()) {
		const task = state.tasks.get(attempt.taskId);
		const objectiveId = task?.objectiveId;
		const goalId = objectiveId?.startsWith("goal:") ? objectiveId.slice("goal:".length) : undefined;
		const recorded = attempt.usage;
		const origin = {
			sessionId,
			taskId: attempt.taskId,
			operationId: attempt.attemptId,
			...(goalId ? { goalId } : {}),
			...(attempt.dispatch.receiptOrigin?.sessionId === sessionId
				? { entryId: attempt.dispatch.receiptOrigin.leafId }
				: {}),
		};
		const context = attempt.agentId ? state.agents.get(attempt.agentId)?.resumeContext : undefined;
		let components: AccountingUsageComponent[] | undefined;
		let transcriptSource: Source | undefined;
		let diagnostic = "No retained worker transcript identity for this attempt.";
		if (context?.provider === "pi" && context.sessionFile) {
			const file = assertWorkerConversationFile(agentDir, context.sessionFile, context.sessionId);
			let transcript = transcripts.get(file);
			if (!transcript) {
				transcript = await readTranscript(file, context.sessionId, context.cwd);
				transcripts.set(file, transcript);
			}
			transcriptSource = transcript.source;
			// Older canonical markers record the exact globally unique attempt ID without a parent field.
			let candidate =
				transcript.byAttempt.get(JSON.stringify([sessionId, attempt.attemptId])) ??
				transcript.byAttempt.get(JSON.stringify([null, attempt.attemptId]));
			if (!candidate && transcript.byAttempt.size === 1 && transcript.byAttempt.has("")) {
				const peers = [...state.attempts.values()].filter((item) => item.agentId === attempt.agentId);
				if (peers.length === 1) candidate = transcript.byAttempt.get("");
			}
			const total = createEmptyUsage();
			for (const component of candidate ?? []) addUsage(total, component.usage);
			if (candidate && sameTotals(usage, total)) components = candidate;
			else diagnostic = "Retained worker responses do not conserve the exact parent receipt group.";
		}
		groups.push({
			reportIds,
			pendingReports: reportIds.flatMap((reportId) => (pending.get(reportId) ? [pending.get(reportId)!] : [])),
			origin,
			...(components ? { components } : { diagnostic }),
			...(recorded
				? {
						activeTime: {
							taskId: attempt.taskId,
							milliseconds: recorded.activeWallClockMs,
							...(goalId ? { goalId } : {}),
						},
					}
				: {}),
			evidence: [
				...sources.map((source) => source.evidence),
				...(transcriptSource ? [transcriptSource.evidence] : []),
			],
		});
	}
	if (
		JSON.stringify(paths) !== JSON.stringify(await eventSourcePaths(store)) ||
		!(
			await Promise.all(
				[...sources, ...[...transcripts.values()].map((item) => item.source)].map((source) => source.unchanged()),
			)
		).every(Boolean)
	)
		throw new FileSnapshotChangedError(
			"Historical worker accounting sources changed; retry the read-only projection.",
		);
	return groups;
}
