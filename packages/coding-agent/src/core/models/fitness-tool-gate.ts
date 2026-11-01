import type { ToolProbeResult } from "../tool-protocol-controller.ts";

/** Task-scale execution is required for autonomous tool-using roles. */
export function toolExecutionFailure(probe: ToolProbeResult | undefined): string | undefined {
	if (!probe) return "was not proven; run /toolprobe and retry /fitness";
	if (probe.verdict === "text-protocol") return undefined;
	if (probe.verdict === "native" && probe.nativeGrade === "task") return undefined;
	if (probe.verdict === "native") return `reported native ${probe.nativeGrade ?? "ungraded"}, not task-scale calls`;
	return `probe reported ${probe.verdict}${probe.diagnostic ? ` (${probe.diagnostic})` : ""}`;
}
