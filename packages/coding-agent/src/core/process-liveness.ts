export type ProcessLivenessProbe = (pid: number, signal: 0) => unknown;

function probeCurrentProcess(pid: number, signal: 0): unknown {
	return process.kill(pid, signal);
}

export function isProcessAlive(pid: number | undefined, probe: ProcessLivenessProbe = probeCurrentProcess): boolean {
	if (pid === undefined || !Number.isFinite(pid) || pid <= 0) return false;
	try {
		probe(pid, 0);
		return true;
	} catch (error) {
		if (!error || typeof error !== "object" || !("code" in error)) return false;
		return String(error.code) === "EPERM";
	}
}
