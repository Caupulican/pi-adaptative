/** Presentation of delegate command outcomes in the orchestration panel. */
import type { DelegateToolDetails } from "./delegate.ts";
import { delegateEventPanelModel } from "./delegate-events.ts";
import { delegateStatusPanelModel } from "./delegate-status.ts";
import type { OrchestrationPanelModel, OrchestrationRowStatus } from "./orchestration-panel.ts";
import { delegateProfilePanelModel } from "./profile-writer.ts";

export function delegatePanelModel(details: DelegateToolDetails | undefined): OrchestrationPanelModel {
	if (!details) {
		return {
			label: "workers",
			action: "dispatch",
			status: "idle",
			emptyText: "No structured worker details were retained.",
		};
	}
	if ("kind" in details) {
		if (details.kind === "events") return delegateEventPanelModel(details);
		return details.kind === "profile" ? delegateProfilePanelModel(details) : delegateStatusPanelModel(details);
	}
	if (details.modelTransfer) {
		const transfer = details.modelTransfer;
		return {
			label: "workers",
			action: `handoff ${transfer.status}`,
			status: transfer.status === "completed" ? "success" : transfer.status === "refused" ? "warning" : "running",
			summary: [
				`${transfer.sourceAgentId} → ${transfer.successorAgentId} (${transfer.targetModelRef})`,
				...(transfer.reasonCode ? [transfer.reasonCode] : []),
			],
		};
	}
	if (!details.started) {
		return {
			label: "workers",
			action: "dispatch skipped",
			status: "warning",
			emptyText: details.skipReason ?? "The worker was not started.",
		};
	}
	const laneStatus = details.status ?? "queued";
	const rowStatus: OrchestrationRowStatus = laneStatus;
	const meta = [
		details.profileId ? `profile ${details.profileId}` : undefined,
		details.modelRef ? `model ${details.modelRef}` : undefined,
		details.thinkingLevel ? `thinking ${details.thinkingLevel}` : undefined,
		details.reasonCode,
		details.accepted === undefined ? undefined : details.accepted ? "accepted" : "not accepted",
		details.costUsd === undefined ? undefined : `$${details.costUsd.toFixed(4)}`,
	].filter((value): value is string => value !== undefined);
	const detailsLines = [
		details.summary ? `untrusted claim: ${details.summary}` : undefined,
		...(details.blockers ?? []).map((blocker) => `blocker: ${blocker}`),
	].filter((value): value is string => value !== undefined);
	const active = laneStatus === "queued" || laneStatus === "running";
	return {
		label: "workers",
		action: active ? "dispatched" : "completed",
		status: active
			? "running"
			: laneStatus === "succeeded" && details.accepted !== false
				? "success"
				: laneStatus === "failed"
					? "error"
					: "warning",
		summary: active ? ["terminal handoff will wake this session"] : undefined,
		rows: [
			{
				status: rowStatus,
				label: details.label ?? details.laneId ?? "worker lane",
				meta: [details.label ? details.laneId : undefined, ...meta].filter(
					(value): value is string => value !== undefined,
				),
				details: detailsLines,
			},
		],
		notices:
			details.accepted === false
				? [{ status: "warning", text: "Worker output was not accepted; inspect and verify before use." }]
				: undefined,
	};
}
