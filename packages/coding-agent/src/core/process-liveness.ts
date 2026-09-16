import { isPositiveSafePid, type ProcessKillProbe, probeProcessLiveness } from "@caupulican/pi-agent-core/process-tree";

export type ProcessLivenessProbe = ProcessKillProbe;

/**
 * Boolean view of {@link probeProcessLiveness} for optional pids.
 * Missing/invalid pid is not a live process for non-recovery callers. Unclassified probe errors
 * never authorize takeover; recovery owners must read the three-valued observation instead.
 */
export function isProcessAlive(pid: number | undefined, probe?: ProcessLivenessProbe): boolean {
	if (!isPositiveSafePid(pid)) return false;
	return probeProcessLiveness(pid, probe) !== "dead";
}
