import { SUMMARIZATION_SYSTEM_PROMPT } from "@caupulican/pi-agent-core/compaction";
import { fauxAssistantMessage } from "@caupulican/pi-ai";
import type { FauxProviderRegistration, FauxResponseFactory, FauxResponseStep } from "@caupulican/pi-ai/faux";
import { getMessageText } from "../suite/harness.ts";

/** Foreground/worker response script used by the host load generator. */
export function createHostResponseScript(faux: FauxProviderRegistration): {
	setResponses(responses: FauxResponseStep[], worker?: boolean): void;
	getSummaryCount(): number;
} {
	const pending = { foreground: [] as FauxResponseStep[], worker: [] as FauxResponseStep[] };
	let foregroundSessionId: string | undefined;
	let foregroundSessionCaptured = false;
	let workerActive = false;
	let summaryCount = 0;
	const next: FauxResponseFactory = (context, options, state, model) => {
		// Keep all completions on the faux provider so its real request/cache measurements include
		// compaction. Summaries must not advance the separately owned foreground/worker script.
		faux.appendResponses([next]);
		const last = context.messages.at(-1);
		if (
			context.systemPrompt === SUMMARIZATION_SYSTEM_PROMPT ||
			(last?.role === "user" &&
				getMessageText(last).startsWith("Create a replacement checkpoint for the conversation above.\n"))
		) {
			summaryCount++;
			// Synthetic content only: the host's normal verification and deterministic gap filling
			// remain enabled. This load generator measures host work, not model summary fidelity.
			return fauxAssistantMessage(
				[
					"## Active Task\nContinue the host profiling script.",
					"### Mandatory Rules\n(none)",
					"## Working Set\n(none)",
					"## Files\n(none)",
					"## Open Problems\n(none)",
					"## Done\nEarlier profiling turns completed.",
					"## Key Decisions\n(none)",
					"## Constraints & Preferences\n(none)",
					"## Critical Context\n(none)",
				].join("\n\n"),
			);
		}
		// The harness foreground legitimately omits sessionId. Capture that identity once;
		// nullish assignment would later mistake the first worker's affinity for the parent.
		if (!foregroundSessionCaptured) {
			foregroundSessionId = options?.sessionId;
			foregroundSessionCaptured = true;
		}
		const foreground = options?.sessionId === foregroundSessionId;
		// Parent terminal-handoff turns are real host work, but must never consume the native
		// worker's response script. The next foreground chunk remains separately queued.
		if (foreground && workerActive && pending.foreground.length === 0)
			return fauxAssistantMessage("Worker handoff received.");
		const response = (foreground ? pending.foreground : pending.worker).shift();
		if (!response) throw new Error("No more host profiling responses queued");
		return typeof response === "function" ? response(context, options, state, model) : response;
	};
	return {
		setResponses(responses, worker = false) {
			pending[worker ? "worker" : "foreground"] = [...responses];
			workerActive = worker;
			faux.setResponses([next]);
		},
		getSummaryCount: () => summaryCount,
	};
}
