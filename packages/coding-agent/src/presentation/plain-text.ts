/**
 * The owner's words for what the host records under technical names. A record type (`background_tool_task`) or a
 * model-facing payload is never shown as it is stored; the stored form stays the source for the model and the transcript.
 */

const PLAIN_LABELS: Readonly<Record<string, string>> = {
	background_tool_task: "Background task",
	background_tool_task_delivery: "Background task result",
	"background-tool-completion": "Background task finished",
	"background-worker-completion": "Agent finished",
	"bot-lane-status": "Bot status",
	"team-message": "Group message",
	"routine-intake": "Routine",
	"routine-completion": "Routine result",
	parent_input_consumed: "Helper message read",
	parent_input_skipped: "Helper message skipped",
	parent_input_wake: "Helper message",
	parent_input_wake_request: "Helper message",
	parent_input_wake_settled: "Helper message handled",
	parent_note_request: "Note for you",
	provider_retry: "Retrying the model",
	provider_admission: "Waiting for a model slot",
	provider_recovery_continuation: "Continuing after a model error",
	provider_transport_telemetry: "Connection details",
	model_router_decision: "Model choice",
	pi_model_pool_policy: "Model pool",
	goal_state: "Goal",
	goal_continuation_trigger: "Goal continues",
	active_goal_context: "Goal",
	continuous_chat_state: "Memory",
	continuous_chat_view: "Memory",
	continuous_chat_work_report: "Memory work",
	knowledge_collection: "Memory",
	knowledge_context: "Memory",
	memory_evidence: "Memory",
	self_compaction_handoff: "Context summary",
	self_compaction_guidance: "Context summary",
	self_compaction_abandoned: "Context summary",
	compaction_prepared: "Context summary",
	runaway_stop: "Stopped a runaway loop",
	"runtime-update-notice": "Update",
	"harness-notice": "Notice",
	"host-event": "Notice",
	owner_items: "For you",
	human_input_request: "Question for you",
	"worker-owner-response": "Your answer",
	queued_owner_input: "Queued message",
	reply_route: "Reply route",
	"proactive-note": "Note",
	"worktree-sync-notice": "Worktree update",
	"process-matrix-notice": "Process update",
	"evidence-retention-audit": "Evidence check",
	learning_audit: "Learning",
	learning_decision: "Learning",
	learning_rollback: "Learning",
	auto_learn_handoff: "Learning",
};

/** Words that stay upper case when a stored name is spelled out. */
const ACRONYMS = new Set(["icm", "okf", "usd", "ci", "id", "api", "url", "mcp", "ui", "tui", "cpu", "gpu", "pid"]);

/** A readable name for a record type: a known one by its phrase, any other with the separators turned into spaces. */
export function plainLabel(id: string): string {
	const known = PLAIN_LABELS[id];
	if (known) return known;
	const spaced = id
		.replace(/^pi[_-]/, "")
		.replace(/[_-]+/g, " ")
		.trim()
		.split(" ")
		.map((word) => (ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word))
		.join(" ");
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const MODEL_FACING_MARKERS = [
	"[harness]",
	"[team-bot-message]",
	"[bot:",
	"<untrusted_content",
	"REPORT REVIEW",
	'"MUST"',
];

/** Whether a message body is a payload written for the model (a marker, or a whole JSON document), not prose for the owner. */
export function isModelFacingText(text: string): boolean {
	if (MODEL_FACING_MARKERS.some((marker) => text.includes(marker))) return true;
	const trimmed = text.trim();
	if (!/^[[{]/.test(trimmed)) return false;
	try {
		JSON.parse(trimmed);
		return true;
	} catch {
		return false;
	}
}

/** The line the owner sees where a model-facing payload would have been. */
export const MODEL_FACING_PLACEHOLDER = "Details for the assistant; they are kept in the transcript.";
