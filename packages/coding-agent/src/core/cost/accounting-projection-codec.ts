import { validateProviderUsage } from "../orchestration/attempt-usage.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import type {
	AccountingEvidenceGroup,
	AccountingOrigin,
	AccountingSourceRevision,
	AccountingUsageComponent,
} from "./accounting-evidence.ts";
import type { HistoricalAccountingProjection } from "./accounting-projection.ts";

function text(value: unknown): string {
	if (typeof value !== "string" || !value || value.length > 4096) throw new Error("Invalid accounting identity.");
	return value;
}

function timestamp(value: unknown): string {
	const at = text(value);
	if (!Number.isFinite(Date.parse(at))) throw new Error("Invalid accounting timestamp.");
	return at;
}

function source(value: unknown): AccountingSourceRevision {
	if (
		!isPlainRecord(value) ||
		!Number.isSafeInteger(value.size) ||
		(value.size as number) < 0 ||
		typeof value.sha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.sha256)
	)
		throw new Error("Invalid accounting source revision.");
	return { path: text(value.path), size: value.size as number, sha256: value.sha256 };
}

function origin(value: unknown, sessionId: string, reportIds: readonly string[]): AccountingOrigin {
	if (!isPlainRecord(value)) throw new Error("Invalid accounting origin.");
	const owner = text(value.sessionId);
	if (
		owner !== sessionId &&
		(!reportIds.length ||
			!reportIds.every((id) => id.startsWith(`worker-usage:${owner}:`) || id.startsWith(`worker:${owner}:`)))
	)
		throw new Error("Foreign accounting origin lacks a matching receipt identity.");
	return {
		sessionId: owner,
		...(value.entryId === undefined ? {} : { entryId: text(value.entryId) }),
		...(value.goalId === undefined ? {} : { goalId: text(value.goalId) }),
		...(value.taskId === undefined ? {} : { taskId: text(value.taskId) }),
		...(value.toolCallId === undefined ? {} : { toolCallId: text(value.toolCallId) }),
		...(value.operationId === undefined ? {} : { operationId: text(value.operationId) }),
	};
}

function list(value: unknown, max = 50_000): unknown[] {
	if (!Array.isArray(value) || value.length > max) throw new Error("Accounting array exceeds its bound.");
	return value;
}

function component(value: unknown): AccountingUsageComponent {
	if (!isPlainRecord(value)) throw new Error("Invalid accounting usage component.");
	if (value.operation !== undefined && value.operation !== "compaction" && value.operation !== "branch_summary")
		throw new Error("Invalid accounting operation.");
	return {
		...(value.operation === undefined ? {} : { operation: value.operation }),
		usage: validateProviderUsage(value.usage),
		timestamp: timestamp(value.timestamp),
		sourceId: text(value.sourceId),
		...(value.provider === undefined ? {} : { provider: text(value.provider) }),
		...(value.model === undefined ? {} : { model: text(value.model) }),
	};
}

/** Materialized evidence is untrusted disk input, validated independently of its producer. */
export function decodeAccountingProjection(value: unknown): HistoricalAccountingProjection {
	if (!isPlainRecord(value) || value.version !== 1) throw new Error("Invalid accounting projection version.");
	const sessionId = text(value.sessionId);
	const reportIds = new Set<string>();
	const componentIds = new Set<string>();
	const directIds = new Set<string>();
	const groups = list(value.groups, 20_000).map((raw): AccountingEvidenceGroup => {
		if (!isPlainRecord(raw)) throw new Error("Invalid accounting evidence group.");
		const ids = list(raw.reportIds).map(text);
		const directEntries =
			raw.directEntries === undefined
				? undefined
				: list(raw.directEntries).map((value): NonNullable<AccountingEvidenceGroup["directEntries"]>[number] => {
						if (
							!isPlainRecord(value) ||
							(value.costStatus !== undefined &&
								value.costStatus !== "unpriced" &&
								value.costStatus !== "catalog_priced")
						)
							throw new Error("Invalid direct accounting entry.");
						const entryId = text(value.entryId);
						if (value.modelProvenance !== undefined && value.modelProvenance !== "request-bound")
							throw new Error("Invalid accounting model provenance.");
						if (directIds.has(entryId)) throw new Error("Direct accounting entry appears twice.");
						directIds.add(entryId);
						return {
							entryId,
							usage: validateProviderUsage(value.usage),
							provider: text(value.provider),
							model: text(value.model),
							...(value.costStatus === undefined ? {} : { costStatus: value.costStatus }),
							...(value.modelProvenance === undefined ? {} : { modelProvenance: value.modelProvenance }),
						};
					});
		if (!ids.length && !directEntries?.length) throw new Error("Accounting evidence group has no receipt identity.");
		if (directEntries?.length && (ids.length || raw.components || raw.pendingReports || raw.activeTime))
			throw new Error("Direct accounting cannot share receipt replacement ownership.");
		for (const id of ids) {
			if (reportIds.has(id)) throw new Error("Accounting receipt appears in multiple evidence groups.");
			reportIds.add(id);
		}
		let activeTime: AccountingEvidenceGroup["activeTime"];
		if (raw.activeTime !== undefined) {
			if (
				!isPlainRecord(raw.activeTime) ||
				typeof raw.activeTime.milliseconds !== "number" ||
				!Number.isFinite(raw.activeTime.milliseconds) ||
				raw.activeTime.milliseconds < 0
			)
				throw new Error("Invalid accounting active time.");
			activeTime = {
				taskId: text(raw.activeTime.taskId),
				milliseconds: raw.activeTime.milliseconds,
				...(raw.activeTime.goalId === undefined ? {} : { goalId: text(raw.activeTime.goalId) }),
			};
		}
		const components = raw.components === undefined ? undefined : list(raw.components).map(component);
		for (const part of components ?? []) {
			if (componentIds.has(part.sourceId)) throw new Error("Accounting source response appears twice.");
			componentIds.add(part.sourceId);
		}
		const pendingIds = new Set<string>();
		return {
			reportIds: ids,
			...(directEntries ? { directEntries } : {}),
			evidence: list(raw.evidence, 20_000).map(source),
			...(raw.origin === undefined ? {} : { origin: origin(raw.origin, sessionId, ids) }),
			...(components ? { components } : {}),
			...(raw.pendingReports === undefined
				? {}
				: {
						pendingReports: list(raw.pendingReports).map((pending) => {
							if (!isPlainRecord(pending)) throw new Error("Invalid pending accounting receipt.");
							const reportId = text(pending.reportId);
							if (!ids.includes(reportId)) throw new Error("Pending accounting receipt is outside its group.");
							if (pendingIds.has(reportId)) throw new Error("Pending accounting receipt appears twice.");
							pendingIds.add(reportId);
							return {
								reportId,
								usage: validateProviderUsage(pending.usage),
								timestamp: timestamp(pending.timestamp),
							};
						}),
					}),
			...(activeTime ? { activeTime } : {}),
			...(raw.diagnostic === undefined ? {} : { diagnostic: text(raw.diagnostic) }),
		};
	});
	return { version: 1, sessionId, createdAt: timestamp(value.createdAt), source: source(value.source), groups };
}
