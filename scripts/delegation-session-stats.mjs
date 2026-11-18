#!/usr/bin/env node
/** Read-only counts of dispatch and owner-visible handoffs in recorded Pi session files, across all their branches. */
import { pathToFileURL } from "node:url";
import { isLaneRecord, isLaneTerminalStatus } from "../packages/coding-agent/src/core/autonomy/lane-tracker.ts";
import { LANE_RECORD_CUSTOM_TYPE } from "../packages/coding-agent/src/core/autonomy/session-lane-record.ts";
import { COMMS_RECORD_VERSION } from "../packages/coding-agent/src/core/comms/comms-records.ts";
import { BACKGROUND_WORKER_COMPLETION_CUSTOM_TYPE } from "../packages/coding-agent/src/core/proof/proof-sheet.ts";
import { ASSIGN_TOOL_NAME } from "../packages/coding-agent/src/core/tools/assign-tool-name.ts";
import { DELEGATE_TOOL_NAME } from "../packages/coding-agent/src/core/tools/delegate-tool-name.ts";
import { isVersionOneSessionSnapshotPayload } from "../packages/coding-agent/src/core/session-snapshot.ts";
import {
	assistantToolCalls,
	parseSessionStatsArgs,
	resolveAutoSinceMs,
	runMain,
	scanSessionJsonl,
} from "./session-stats-common.mjs";

function dispatchOutcome(message) {
	const details = message.details;
	if (message.isError === true || details?.started === false) return "refused";
	if (details?.started !== true) return "unknown";
	if (details.messageId) return "existingAgentMessage";
	if (typeof details.laneId !== "string" || !details.laneId) return "unknown";
	if (details.fanout !== undefined) {
		const members = details.fanout?.members;
		if (!Array.isArray(members) || members.length === 0) return "unknown";
		if (members.some((member) => member?.skipReason)) return "partial";
		if (!members.every((member) => typeof member?.laneId === "string" && member.laneId)) return "unknown";
	}
	return "admitted";
}

function recordStatus(records, record) {
	const key = JSON.stringify([record.laneId, record.attemptId]);
	const statuses = records.get(key) ?? new Set();
	statuses.add(record.status);
	records.set(key, statuses);
}

export async function delegationStats(sessionsDir, sinceMs = null) {
	const firstDispatch = {
		admitted: 0,
		partial: 0,
		refused: 0,
		existingAgentMessage: 0,
		unknown: 0,
		noStartAttempt: 0,
	};
	const handoffs = {};
	let terminalRowsWithoutAttemptId = 0;
	let undecodableLaneRows = 0;
	let undecodableHandoffMessages = 0;
	let handoffRowsWithoutIdentity = 0;
	const { meta } = await scanSessionJsonl({
		sessionsDir,
		sinceMs,
		createSession: () => ({ first: undefined, terminals: new Map(), visible: new Map() }),
		onEntry(entry, session) {
			const message = entry?.type === "message" ? entry.message : undefined;
			for (const call of assistantToolCalls(message)) {
				if (call?.type !== "toolCall") continue;
				if (call.name === DELEGATE_TOOL_NAME) {
					const action = call.arguments?.action ?? "start";
					// "spawn" is a historically observed failed spelling of the delegate start action.
					if (action !== "start" && action !== "spawn") continue;
				} else if (call.name !== ASSIGN_TOOL_NAME) continue;
				if (!session.first) session.first = { tool: call.name, id: typeof call.id === "string" ? call.id : undefined, outcomes: new Set() };
				else if (session.first.tool === call.name && session.first.id === call.id) session.first.ambiguous = true;
			}
			const first = session.first;
			if (
				first?.id &&
				message?.role === "toolResult" &&
				message.toolName === first.tool &&
				message.toolCallId === first.id
			) {
				first.outcomes.add(dispatchOutcome(message));
			}
			if (entry?.type === "custom" && entry.customType === LANE_RECORD_CUSTOM_TYPE) {
				const record = entry.data?.record;
				if (!isVersionOneSessionSnapshotPayload(entry.data) || !isLaneRecord(record)) undecodableLaneRows++;
				else if (
					isLaneTerminalStatus(record.status) &&
					(record.type === "worker" || record.type === "managed-worker")
				) {
					if (record.attemptId) recordStatus(session.terminals, record);
					else terminalRowsWithoutAttemptId++;
				}
			}
			if (
				entry?.type === "custom_message" &&
				entry.customType === BACKGROUND_WORKER_COMPLETION_CUSTOM_TYPE &&
				entry.display === true
			) {
				// Before the version tag existed these records already carried lane, attempt and terminal status.
				const details = entry.details;
				if ((details?.v !== undefined && details.v !== COMMS_RECORD_VERSION) || !Array.isArray(details?.records)) {
					undecodableHandoffMessages++;
					return;
				}
				for (const record of details.records) {
					if (
						typeof record?.attemptId === "string" &&
						record.attemptId &&
						typeof record.laneId === "string" &&
						record.laneId &&
						isLaneTerminalStatus(record.status)
					)
						recordStatus(session.visible, record);
					else handoffRowsWithoutIdentity++;
				}
			}
		},
		onSessionEnd(session) {
			const first = session.first;
			const outcome = !first
				? "noStartAttempt"
				: first.ambiguous || first.outcomes.size !== 1
					? "unknown"
					: [...first.outcomes][0];
			firstDispatch[outcome]++;
			for (const [key, terminal] of session.terminals) {
				const status = terminal.size === 1 ? [...terminal][0] : "conflicting";
				const totals = (handoffs[status] ??= { matched: 0, missingVisibleRecord: 0, conflicting: 0 });
				const visible = session.visible.get(key);
				if (terminal.size !== 1 || (visible && (visible.size !== 1 || !visible.has(status)))) totals.conflicting++;
				else if (visible) totals.matched++;
				else totals.missingVisibleRecord++;
			}
		},
	});
	return {
		scan: meta,
		firstDispatch,
		handoffs,
		terminalRowsWithoutAttemptId,
		undecodableLaneRows,
		undecodableHandoffMessages,
		handoffRowsWithoutIdentity,
	};
}

async function main() {
	const options = parseSessionStatsArgs(process.argv.slice(2), {}, () => null);
	if (options.help) {
		console.log(
			"node --conditions=pi-source scripts/delegation-session-stats.mjs --sessions-dir <directory> [--since <date>]",
		);
		return;
	}
	if (!options.sessionsDir || options.text || (options.allSessions && options.since))
		throw new Error("Supply --sessions-dir and optionally --since. Output is JSON.");
	const since = await resolveAutoSinceMs(options);
	console.log(JSON.stringify(await delegationStats(options.sessionsDir, since?.ms), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runMain(main);
