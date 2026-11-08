import { harnessLog } from "../../kernel/harness-log.ts";
import type { ToolProbeResult } from "../tool-protocol-controller.ts";
import type { NativeToolProbeGrade } from "./adaptation-store.ts";

/** The owner's words for a native probe grade. */
const NATIVE_GRADE_WORDS: Readonly<Record<NativeToolProbeGrade, string>> = {
	task: "reached task-scale calls",
	"echo-only": "only echoed the test back",
	absent: "made no native tool calls",
};

/** The owner's words for a probe verdict that is not a usable tool protocol. */
const PROBE_VERDICT_WORDS: Readonly<Record<"none" | "inconclusive", string>> = {
	none: "was not found",
	inconclusive: "was inconclusive",
};

/** Task-scale execution is required for autonomous tool-using roles. */
export function toolExecutionFailure(probe: ToolProbeResult | undefined): string | undefined {
	if (!probe) return "was not proven; run /toolprobe and retry /fitness";
	if (probe.verdict === "text-protocol") return undefined;
	if (probe.verdict === "native" && probe.nativeGrade === "task") return undefined;
	if (probe.verdict === "native") {
		harnessLog.debug("ui", "a native tool probe did not reach task-scale calls", {
			model: probe.model,
			nativeGrade: probe.nativeGrade,
		});
		return `${probe.nativeGrade ? NATIVE_GRADE_WORDS[probe.nativeGrade] : "gave no grade"}, not task-scale calls`;
	}
	harnessLog.debug("ui", "a tool probe did not prove task-scale calls", {
		model: probe.model,
		verdict: probe.verdict,
		diagnostic: probe.diagnostic,
	});
	return PROBE_VERDICT_WORDS[probe.verdict];
}
