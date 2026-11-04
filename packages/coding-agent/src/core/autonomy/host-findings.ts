/**
 * What the host itself observed about a worker (concurrent writes, protected paths, its lane, findings left out of a
 * bounded claim), as typed findings. A claim carries them in `hostFindings`, and the review gate reads that field;
 * the blocker line each finding renders is a display of the same fact and is never read back for a decision.
 */

import { boundedText } from "../util/bounded-line.ts";
import type { WorkerHostFinding, WorkerHostFindingCode } from "./contracts.ts";

/** The leading label of the blocker line a finding renders, so the parent reads which observation it is. */
export const HOST_FINDING_LABEL: Readonly<Record<WorkerHostFindingCode, string>> = {
	overlap: "worker_write_overlap:",
	protected_path: "protected_path_changed:",
	lane: "worker_lane:",
	omitted: "host_findings:",
};

/** Most characters of one rendered finding line, label included: a claim blocker holds at most 1,000. */
export const MAX_HOST_FINDING_LINE_CHARS = 960;

/** A finding whose rendered blocker line fits {@link MAX_HOST_FINDING_LINE_CHARS}; the text is cut by head and tail. */
export function hostFinding(code: WorkerHostFindingCode, text: string): WorkerHostFinding {
	const room = MAX_HOST_FINDING_LINE_CHARS - HOST_FINDING_LABEL[code].length - 1;
	return { code, text: boundedText(text, room) };
}

/** The blocker line a finding renders. */
export function hostFindingBlockerLine(finding: WorkerHostFinding): string {
	return `${HOST_FINDING_LABEL[finding.code]} ${finding.text}`;
}
