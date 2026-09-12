import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMissingFileError } from "../util/atomic-file.ts";

/**
 * Machine-wide emergency stop: a sentinel file at `<agentDir>/ESTOP` pauses NEW worker and
 * background provider work in every pi process on this agent directory. In-flight foreground turns
 * continue and nothing is killed; workers waiting to start stay queued, and a running worker's next
 * provider request waits (bounded) instead of being sent. The check is one `existsSync`, so every
 * scheduler may run it on each tick. A corrupt or empty file still counts as engaged (fail safe):
 * the pause must hold even if the file was created with `touch`.
 *
 * Modelled on the operator control that other harnesses ship for the same box-wide situation;
 * ours had no way to hold every pi at once when a shared account was being hammered.
 */

export interface EmergencyStopState {
	engaged: boolean;
	reason?: string;
	engagedAt?: string;
	path: string;
}

export function emergencyStopPath(agentDir: string): string {
	return join(agentDir, "ESTOP");
}

export function isEmergencyStopEngaged(agentDir: string): boolean {
	return existsSync(emergencyStopPath(agentDir));
}

export function readEmergencyStop(agentDir: string): EmergencyStopState {
	const path = emergencyStopPath(agentDir);
	if (!existsSync(path)) return { engaged: false, path };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as { reason?: unknown; engagedAt?: unknown };
		return {
			engaged: true,
			path,
			...(typeof parsed.reason === "string" && parsed.reason ? { reason: parsed.reason } : {}),
			...(typeof parsed.engagedAt === "string" ? { engagedAt: parsed.engagedAt } : {}),
		};
	} catch {
		// An unreadable body is still an engaged stop.
		return { engaged: true, path };
	}
}

export function engageEmergencyStop(
	agentDir: string,
	reason?: string,
	now: () => number = Date.now,
): EmergencyStopState {
	const path = emergencyStopPath(agentDir);
	const engagedAt = new Date(now()).toISOString();
	writeFileSync(path, `${JSON.stringify({ ...(reason ? { reason } : {}), engagedAt })}\n`, { mode: 0o600 });
	return { engaged: true, path, engagedAt, ...(reason ? { reason } : {}) };
}

/** Returns true when a stop was engaged and is now lifted. */
export function liftEmergencyStop(agentDir: string): boolean {
	const path = emergencyStopPath(agentDir);
	if (!existsSync(path)) return false;
	try {
		rmSync(path, { force: true });
	} catch (error) {
		if (!isMissingFileError(error)) throw error;
	}
	return true;
}
