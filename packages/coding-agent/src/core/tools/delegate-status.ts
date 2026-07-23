import { type Static, Type } from "typebox";
import type { WorkerClaim } from "../autonomy/contracts.ts";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import type { ToolDefinition } from "../extensions/types.ts";

const schema = Type.Object(
	{
		laneId: Type.Optional(
			Type.String({ description: "Worker lane id to inspect. Omit it for a recent-session status overview." }),
		),
		action: Type.Optional(
			Type.Literal("review", {
				description:
					'Pass "review" together with laneId to durably acknowledge that worker\'s unreviewed mutation, clearing its sticky notice. Not required to read a status.',
			}),
		),
	},
	{ additionalProperties: false },
);
type Input = Static<typeof schema>;

export type AcknowledgeWorkerReviewResult =
	| { ok: true; requestId: string; reviewedAt: string }
	| { ok: false; reason: "unknown_worker_claim" | "not_flagged" | "already_reviewed" };

export interface DelegateStatusDependencies {
	getLaneRecords(): LaneRecord[];
	getWorkerClaimSnapshots(): WorkerClaim[];
	/**
	 * Durably acknowledge an unreviewed worker mutation (parentReviewRequired), clearing its
	 * sticky notice. Optional so callers without durable persistence wired still type-check; without
	 * it the "review" action reports itself unsupported instead of silently no-op'ing.
	 */
	acknowledgeWorkerReview?(requestId: string): AcknowledgeWorkerReviewResult;
}

/** A worker claim flagged parent_review_required whose mutation has not yet been acked. */
function isUnreviewed(claim: WorkerClaim | undefined): boolean {
	return claim?.parentReviewRequired === true && claim.parentReviewedAt === undefined;
}

/** In-process `worker` lanes and out-of-process `tmux-worker` lanes are both delegated work whose
 * output is an untrusted claim under the same review machinery — surfaced together here. */
function isDelegatedWorkerLane(record: LaneRecord): boolean {
	return record.type === "worker" || record.type === "tmux-worker";
}

function formatRecord(record: LaneRecord, claim: WorkerClaim | undefined): string {
	const lines = [`${record.laneId}: ${record.status}${record.reasonCode ? ` (${record.reasonCode})` : ""}`];
	if (!claim) return lines.join("\n");
	lines.push(`usageReportId: ${claim.usageReportId ?? "none"}`);
	if (isUnreviewed(claim)) {
		lines.push(
			`UNREVIEWED MUTATION - this worker's claim requires explicit parent review. Acknowledge with delegate_status { laneId: "${record.laneId}", action: "review" }.`,
		);
	} else if (claim.parentReviewRequired && claim.parentReviewedAt) {
		lines.push(`reviewed at ${claim.parentReviewedAt}`);
	}
	lines.push("UNTRUSTED worker output — verify before acting on it:");
	lines.push(claim.summary.slice(0, 8000));
	if (claim.changedFiles.length > 0) lines.push(`changed files: ${claim.changedFiles.join(", ")}`);
	if (claim.blockers?.length) lines.push(`blockers: ${claim.blockers.join("; ")}`);
	return lines.join("\n").slice(0, 16 * 1024);
}

export function createDelegateStatusToolDefinition(deps: DelegateStatusDependencies): ToolDefinition {
	return {
		name: "delegate_status",
		label: "delegate_status",
		description:
			'Inspect queued, running, and terminal workers in this session, retrieve one worker\'s bounded, explicitly untrusted claim, or acknowledge (action: "review") an unreviewed worker mutation.',
		promptSnippet:
			"Inspect delegated workers after a terminal handoff without receiving a late transcript injection; acknowledge unreviewed mutations.",
		parameters: schema,
		async execute(_toolCallId, input: Input) {
			if (input.action === "review") {
				if (!input.laneId) {
					return {
						content: [{ type: "text" as const, text: "review action requires laneId" }],
						details: { reviewed: false, reason: "missing_lane_id" },
					};
				}
				if (!deps.acknowledgeWorkerReview) {
					return {
						content: [{ type: "text" as const, text: "review acknowledgement is not available in this session" }],
						details: { reviewed: false, reason: "review_unsupported" },
					};
				}
				const outcome = deps.acknowledgeWorkerReview(input.laneId);
				if (!outcome.ok) {
					return {
						content: [
							{ type: "text" as const, text: `review not acknowledged (${input.laneId}): ${outcome.reason}` },
						],
						details: { laneId: input.laneId, reviewed: false, reason: outcome.reason },
					};
				}
				return {
					content: [
						{
							type: "text" as const,
							text: `reviewed ${input.laneId} at ${outcome.reviewedAt} — unreviewed-mutation notice cleared`,
						},
					],
					details: { laneId: input.laneId, reviewed: true, reviewedAt: outcome.reviewedAt },
				};
			}

			const records = deps.getLaneRecords().filter(isDelegatedWorkerLane);
			const claims = new Map(deps.getWorkerClaimSnapshots().map((claim) => [claim.requestId, claim]));
			// Sticky: computed over ALL worker records, not just the recent window below — an
			// unreviewed mutation must stay visible no matter how much later lane churn buries it.
			const unreviewedRecords = records.filter((record) => isUnreviewed(claims.get(record.laneId)));

			if (input.laneId) {
				const record = records.find((candidate) => candidate.laneId === input.laneId);
				if (!record) {
					return {
						content: [{ type: "text" as const, text: "unknown_worker_lane" }],
						details: { reason: "unknown_worker_lane" },
					};
				}
				return {
					content: [{ type: "text" as const, text: formatRecord(record, claims.get(record.laneId)) }],
					details: {
						laneId: record.laneId,
						status: record.status,
						unreviewed: isUnreviewed(claims.get(record.laneId)),
					},
				};
			}

			const recentRecords = records.slice(-10);
			const recentLaneIds = new Set(recentRecords.map((record) => record.laneId));
			const queued = records.filter((record) => record.status === "queued").length;
			const running = records.filter((record) => record.status === "running").length;
			const terminal = records.length - queued - running;
			const recent = recentRecords.map((record) => formatRecord(record, claims.get(record.laneId)));
			const olderUnreviewed = unreviewedRecords.filter((record) => !recentLaneIds.has(record.laneId));
			const olderUnreviewedText =
				olderUnreviewed.length > 0
					? `\n\nOlder unreviewed workers (outside the recent list):\n${olderUnreviewed
							.map((record) => formatRecord(record, claims.get(record.laneId)))
							.join("\n\n")}`
					: "";
			const overviewLines = [`workers: ${running} running, ${queued} queued, ${terminal} terminal`];
			if (unreviewedRecords.length > 0) {
				overviewLines.push(
					`${unreviewedRecords.length} unreviewed worker mutation${unreviewedRecords.length === 1 ? "" : "s"} pending review: ${unreviewedRecords.map((record) => record.laneId).join(", ")}. Acknowledge each with delegate_status { laneId, action: "review" }.`,
				);
			}
			const overview = overviewLines.join("\n");
			return {
				content: [
					{
						type: "text" as const,
						text:
							recent.length > 0
								? `${overview}\n\n${recent.join("\n\n")}${olderUnreviewedText}`.slice(0, 16 * 1024)
								: "No worker lanes.",
					},
				],
				details: {
					count: recent.length,
					queued,
					running,
					terminal,
					unreviewedCount: unreviewedRecords.length,
					unreviewedLaneIds: unreviewedRecords.map((record) => record.laneId),
				},
			};
		},
	};
}
