/** Attributes terminal reports to one ordinary request and identifies new evidence since its last checkpoint. */
import { parentInputOriginalDetails } from "../kernel/session/parent-input-ledger.ts";
import { isPlainRecord } from "../kernel/utils/value-guards.ts";
import { isLaneTerminalStatus } from "./autonomy/lane-tracker.ts";
import { backgroundToolInvocationObservations } from "./background-tool-task-controller.ts";
import type { OrdinaryWorkEvidence } from "./ordinary-work-controller.ts";
import { BACKGROUND_WORKER_COMPLETION_CUSTOM_TYPE, PLAN_UPDATE_CUSTOM_TYPE } from "./proof/proof-sheet.ts";

function ordinaryCompletionType(type: string): boolean {
	return (
		type === BACKGROUND_WORKER_COMPLETION_CUSTOM_TYPE ||
		type === "background-tool-completion" ||
		type === PLAN_UPDATE_CUSTOM_TYPE
	);
}

export function ordinaryCompletionReports({ entries, record }: Pick<OrdinaryWorkEvidence, "entries" | "record">): {
	reports: readonly string[];
	fresh: boolean;
} {
	const frontier = entries.findIndex((entry) => entry.id === record.frontierEntryId);
	if (frontier < 0) return { reports: [], fresh: false };
	const preceding = new Set<string>();
	const servedHere = (origin: unknown): boolean =>
		isPlainRecord(origin) &&
		origin.sessionId === record.sessionId &&
		typeof origin.leafId === "string" &&
		preceding.has(origin.leafId);
	const legacyLanes = new Set<string>();
	const tools = new Map<string, { taskId: string; toolName: string }>();
	const reports = new Map<string, string>();
	let fresh = false;
	const add = (key: string, text: string, index: number): void => {
		if (reports.get(key) === text) return;
		reports.delete(key);
		reports.set(key, text);
		if (index > frontier) fresh = true;
	};
	for (const [index, entry] of entries.entries()) {
		const inLaunchScope = record.status !== "waiting" || index <= frontier;
		if (inLaunchScope && entry.type === "message" && entry.message.role === "toolResult" && !entry.message.isError) {
			const { details, toolName, toolCallId } = entry.message;
			if (isPlainRecord(details)) {
				if (
					details.status === "running" &&
					details.sessionId === record.sessionId &&
					typeof details.taskId === "string"
				)
					tools.set(toolCallId, { taskId: details.taskId, toolName });
				if (
					toolName === "delegate" &&
					details.started === true &&
					(details.action === undefined || details.action === "start" || details.action === "follow_up")
				) {
					if (typeof details.laneId === "string") legacyLanes.add(details.laneId);
					if (isPlainRecord(details.fanout) && Array.isArray(details.fanout.members)) {
						for (const member of details.fanout.members)
							if (isPlainRecord(member) && typeof member.laneId === "string" && !member.skipReason)
								legacyLanes.add(member.laneId);
					}
				}
			}
		} else if (entry.type === "custom_message" && ordinaryCompletionType(entry.customType)) {
			const details = parentInputOriginalDetails(entry) ?? entry.details;
			if (isPlainRecord(details) && details.thirdParty !== true) {
				if (
					entry.customType === PLAN_UPDATE_CUSTOM_TYPE &&
					servedHere(details.served) &&
					(details.kind === "settled" || details.kind === "failed" || details.kind === "join") &&
					typeof entry.content === "string"
				) {
					add(
						JSON.stringify(["plan", details.planId, details.version, details.kind, details.nodeId]),
						entry.content,
						index,
					);
				} else if (
					entry.customType === BACKGROUND_WORKER_COMPLETION_CUSTOM_TYPE &&
					Array.isArray(details.records)
				) {
					for (const r of details.records) {
						if (!isPlainRecord(r) || typeof r.laneId !== "string" || !isLaneTerminalStatus(r.status)) continue;
						if (r.served === undefined ? !legacyLanes.has(r.laneId) : !servedHere(r.served)) continue;
						const { laneId, attemptId, status, reasonCode, claim, outcome, hostVerdict } = r;
						add(
							JSON.stringify(["worker", laneId, attemptId]),
							JSON.stringify({ laneId, attemptId, status, reasonCode, claim, outcome, hostVerdict }),
							index,
						);
					}
				} else if (entry.customType === "background-tool-completion") {
					for (const result of backgroundToolInvocationObservations({ customType: entry.customType, details })) {
						const r = result.details;
						const launch = tools.get(result.toolCallId);
						if (!launch || !isPlainRecord(r) || r.taskId !== launch.taskId || r.toolName !== launch.toolName)
							continue;
						const { taskId, toolCallId, status, toolName, artifactId, piVerification } = r;
						add(
							JSON.stringify(["tool", taskId, toolCallId]),
							JSON.stringify({
								taskId,
								toolCallId,
								status,
								toolName,
								artifactId,
								piVerification,
								output: "Read the task to inspect its output",
							}),
							index,
						);
					}
				}
			}
		}
		if (inLaunchScope) preceding.add(entry.id);
	}
	return { reports: [...reports.values()], fresh };
}
