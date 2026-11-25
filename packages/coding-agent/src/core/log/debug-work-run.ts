/** Applies inactive-run retention to managed TUI captures and on-demand debug reports. */
import { getProcessWorkRun } from "../../utils/work-directory.ts";

const DEBUG_RETENTION = { maxAgeMs: 7 * 86_400_000, maxRuns: 6, maxTotalBytes: 32 * 1024 * 1024 };

export function getProcessDiagnosticWorkRun(agentDir: string, kind: "tui" | "report") {
	const [category, tenant] = kind === "tui" ? ["debug", "tui"] : ["logs", "debug"];
	return getProcessWorkRun(agentDir, category, tenant, undefined, DEBUG_RETENTION);
}

export function configureTuiDiagnosticWorkDir(agentDir: string): void {
	if (process.env.PI_TUI_DEBUG !== "1" && process.env.PI_DEBUG_REDRAW !== "1") return;
	try {
		process.env.PI_TUI_WORK_DIR = getProcessDiagnosticWorkRun(agentDir, "tui").path;
	} catch {
		// Leave the TUI's bounded capture fallback available if managed storage cannot be opened.
	}
}
