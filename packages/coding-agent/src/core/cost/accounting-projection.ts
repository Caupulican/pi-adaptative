import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Usage } from "@caupulican/pi-ai";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import { addUsage, createEmptyUsage } from "../../kernel/usage.ts";
import { validateProviderUsage } from "../orchestration/attempt-usage.ts";
import type { AccountingEvidenceGroup, AccountingSourceRevision } from "./accounting-evidence.ts";
import {
	type RecoveredDirectUsageReport,
	SEMANTIC_USAGE_CUSTOM_TYPE,
	SPAWNED_USAGE_CUSTOM_TYPE,
} from "./usage-records.ts";

export interface HistoricalAccountingProjection {
	readonly version: 1;
	readonly sessionId: string;
	readonly source: AccountingSourceRevision;
	readonly createdAt: string;
	readonly groups: readonly AccountingEvidenceGroup[];
}

/** Original receipt IDs remain present as ancestry anchors in this read-only projection. */
export function projectHistoricalAccounting(
	entries: readonly SessionEntry[],
	projection: HistoricalAccountingProjection | undefined,
): readonly SessionEntry[] {
	if (!projection?.groups.length) return entries;
	const knownReports = new Set(
		entries.flatMap((entry) => {
			const data = entry.type === "custom" ? (entry.data as { reportId?: string } | undefined) : undefined;
			return data?.reportId ? [data.reportId] : [];
		}),
	);
	const pending: SessionEntry[] = [];
	for (const group of projection.groups)
		for (const report of group.pendingReports ?? []) {
			if (knownReports.has(report.reportId)) continue;
			knownReports.add(report.reportId);
			const digest = createHash("sha256").update(`${projection.sessionId}:${report.reportId}`).digest("hex");
			pending.push({
				type: "custom",
				id: `accounting-pending-${digest}`,
				parentId: entries.at(-1)?.id ?? null,
				timestamp: report.timestamp,
				customType: SPAWNED_USAGE_CUSTOM_TYPE,
				data: {
					usage: report.usage,
					reportId: report.reportId,
					origin: group.origin,
					goalId: group.origin?.goalId,
				},
			});
		}
	const available = [...entries, ...pending];
	const direct = new Map(
		projection.groups.flatMap((group) =>
			(group.directEntries ?? []).map((entry) => [entry.entryId, { entry, origin: group.origin }] as const),
		),
	);
	const groups = new Map<string, AccountingEvidenceGroup>();
	const members = new Map<AccountingEvidenceGroup, Extract<SessionEntry, { type: "custom" }>[]>();
	for (const group of projection.groups) {
		for (const id of group.reportIds) {
			if (groups.has(id)) throw new Error(`Historical accounting report belongs to multiple groups: ${id}`);
			groups.set(id, group);
		}
	}
	for (const entry of available) {
		if (
			entry.type !== "custom" ||
			(entry.customType !== SPAWNED_USAGE_CUSTOM_TYPE && entry.customType !== SEMANTIC_USAGE_CUSTOM_TYPE)
		)
			continue;
		const data = entry.data as { reportId?: string } | undefined;
		const group = data?.reportId ? groups.get(data.reportId) : undefined;
		if (group) {
			const list = members.get(group) ?? [];
			list.push(entry);
			members.set(group, list);
		}
	}
	const resolved = new Set<AccountingEvidenceGroup>();
	for (const [group, list] of members) {
		const ids = new Set(list.map((entry) => (entry.data as { reportId: string }).reportId));
		if (ids.size !== group.reportIds.length) continue;
		if (group.components) {
			const recorded = createEmptyUsage();
			const seen = new Set<string>();
			for (const entry of list) {
				const data = entry.data as { reportId: string; usage: Usage };
				if (seen.has(data.reportId)) continue;
				seen.add(data.reportId);
				addUsage(recorded, validateProviderUsage(data.usage));
			}
			const recovered = createEmptyUsage();
			for (const component of group.components) addUsage(recovered, validateProviderUsage(component.usage));
			const tokensMatch =
				recorded.input === recovered.input &&
				recorded.output === recovered.output &&
				recorded.cacheRead === recovered.cacheRead &&
				recorded.cacheWrite === recovered.cacheWrite &&
				recorded.totalTokens === recovered.totalTokens;
			const costMatches =
				Math.abs(recorded.cost.total - recovered.cost.total) <=
				Math.max(1e-9, Number.EPSILON * Math.abs(recorded.cost.total));
			if (!tokensMatch || !costMatches)
				throw new Error("Historical accounting components violate receipt conservation.");
		}
		resolved.add(group);
	}
	const result: SessionEntry[] = [];
	const matchedDirect = new Set<string>();
	const emitted = new Set<AccountingEvidenceGroup>();
	for (const entry of available) {
		const replacement = direct.get(entry.id);
		if (replacement) {
			matchedDirect.add(entry.id);
			if (
				entry.type !== "message" ||
				entry.message.role !== "toolResult" ||
				!entry.message.usage ||
				!isDeepStrictEqual(
					validateProviderUsage(entry.message.usage),
					validateProviderUsage(replacement.entry.usage),
				)
			)
				throw new Error("Direct accounting evidence conflicts with recorded tool usage.");
			const { usage: _usage, ...message } = entry.message;
			result.push({ ...entry, message });
			result.push({
				type: "custom",
				id: `accounting-direct-${entry.id}`,
				parentId: entry.id,
				timestamp: entry.timestamp,
				customType: SEMANTIC_USAGE_CUSTOM_TYPE,
				data: {
					...replacement.entry,
					usage: entry.message.usage,
					reportId: `accounting:direct:${projection.sessionId}:${entry.id}`,
					costBasis: "direct",
					route: "system_one_tool",
					origin: { ...replacement.origin, sessionId: projection.sessionId, entryId: entry.id },
				} satisfies RecoveredDirectUsageReport,
			});
			continue;
		}
		const data = entry.type === "custom" ? (entry.data as { reportId?: string } | undefined) : undefined;
		const group = data?.reportId ? groups.get(data.reportId) : undefined;
		if (!group || !resolved.has(group) || entry.type !== "custom") {
			result.push(entry);
			continue;
		}
		const origin = group.origin;
		if (!group.components) {
			result.push({ ...entry, data: { ...data, ...(origin ? { origin, goalId: origin.goalId } : {}) } });
		} else {
			result.push({ ...entry, customType: "accounting_source_receipt" });
			if (!emitted.has(group)) {
				for (const component of group.components) {
					const digest = createHash("sha256")
						.update(`${projection.sessionId}:${component.sourceId}`)
						.digest("hex");
					result.push({
						type: "custom",
						id: `accounting-${digest}`,
						parentId: entry.id,
						timestamp: component.timestamp,
						customType: entry.customType,
						data: {
							usage: component.usage,
							reportId: `accounting:${component.sourceId}`,
							provider: component.provider,
							model: component.model,
							...(component.operation && !component.model
								? { label: `${component.operation} (model unrecorded)` }
								: {}),
							costBasis: "response",
							...(origin ? { origin, goalId: origin.goalId } : {}),
						},
					});
				}
			}
		}
		if (!emitted.has(group) && group.activeTime) {
			const digest = createHash("sha256").update(`${projection.sessionId}:${group.reportIds[0]}`).digest("hex");
			result.push({
				type: "custom",
				id: `accounting-time-${digest}`,
				parentId: entry.id,
				timestamp: entry.timestamp,
				customType: "accounting_worker_time",
				data: { ...group.activeTime, origin },
			});
		}
		emitted.add(group);
	}
	if (matchedDirect.size !== direct.size) throw new Error("Direct accounting evidence has no recorded entry.");
	return result;
}
