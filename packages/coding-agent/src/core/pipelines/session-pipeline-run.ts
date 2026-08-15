import type { SessionManager } from "@caupulican/pi-agent-core/node";
import {
	appendSessionSnapshot,
	decodeSessionSnapshotPayload,
	getLatestSessionSnapshotOnBranch,
	type SessionSnapshotCodec,
} from "../session-snapshot.ts";
import { clonePipelineRun, isPipelineRun, PIPELINE_RUN_CUSTOM_TYPE, type PipelineRun } from "./types.ts";

const PIPELINE_RUN_SNAPSHOT_CODEC: SessionSnapshotCodec<PipelineRun, "run"> = {
	customType: PIPELINE_RUN_CUSTOM_TYPE,
	valueKey: "run",
	isValue: isPipelineRun,
	clone: clonePipelineRun,
};

export function appendPipelineRunSnapshot(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	run: PipelineRun,
): string {
	return appendSessionSnapshot(sessionManager, PIPELINE_RUN_SNAPSHOT_CODEC, run);
}

export function decodePipelineRunSnapshotPayload(data: unknown): PipelineRun | undefined {
	return decodeSessionSnapshotPayload(data, PIPELINE_RUN_SNAPSHOT_CODEC);
}

export function getLatestPipelineRunSnapshot(
	sessionManager: Pick<SessionManager, "getLatestCustomEntryOnBranch">,
): PipelineRun | undefined {
	return getLatestSessionSnapshotOnBranch(sessionManager, PIPELINE_RUN_SNAPSHOT_CODEC);
}
