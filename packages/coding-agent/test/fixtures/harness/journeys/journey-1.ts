import "../builtin-install.ts";
import { projectPath } from "../session-fixture.ts";
import { runJourney1ContinuousChatPhase } from "./journey-1-continuous-chat.ts";
import { runJourney1HostShutdownPhase } from "./journey-1-host-shutdown.ts";
import { runJourney1IntentAndBranchingPhase } from "./journey-1-intent-and-branching.ts";
import { runJourney1OwnerLifecyclePhase } from "./journey-1-owner-lifecycle.ts";
import { verifySessionReplacementTerminalIdentity } from "./journey-1-session-replacement.ts";
import { runJourney1WorkerBudgetsPhase } from "./journey-1-worker-budgets.ts";
import { runJourney1WriteReservationsPhase } from "./journey-1-write-reservations.ts";
/**
 * The real proper-lockfile runs its exclusion and lease logic; only its filesystem is redirected to the
 * active world's virtual fs through the library's own `fs` option, so no lock directory reaches disk.
 * The library's CJS export object is the one production's default import receives, so its functions
 * are rebound in place rather than through an ESM module mock.
 */
import { LIMITS_PATH, runJourney } from "./shared.ts";

export async function runJourney1(): Promise<void> {
	await runJourney(
		{
			name: "journey-1",
			journey: 1,
			// The E2 control's uncertain task relation emits one native warning, counted in its own block (not a broad allowance).
			// The long-path turn meets an unavailable evaluator on purpose: its owner intent stays unresolved, and only that
			// classified-as-unavailable warning is allowed.
			warningAllowances: [
				/^Optional integrations stay available; owner intent for them was not classified: Jev System One unavailable for impact 'read_only': TypeSafe HTTP 503\.$/,
				/^Optional integrations stay available; owner intent for them was not classified: the judgment was uncertain\.$/,
				// The E13R and E13Q live owners' refused releases: the settled lane hands the record to its retry, and the backoff alarm reports
				// each retry it makes before the refusal is cleared. Each refusal is named exactly (E13R, and the three E13Q entrances). Each message exactly: the lane, the reservation uuid, the refused unlink of the
				// store or rename of its temporary rewrite, with the platform root narrowed to its POSIX or drive-letter form.
				/^Failed to release worker write reservation worker-\d+; retrying: Scripted IO fault (?:e13r|e13q-(?:start|follow-up|reuse))-release-denied: (?:unlink|rename) '(?:\/harness\/agent-journey-1-system-one-(?:on|off)\/state\/orchestration\/worker-write-reservations\/|[A-Z]:\\harness\\agent-journey-1-system-one-(?:on|off)\\state\\orchestration\\worker-write-reservations\\)[0-9a-f]{64}\.json(?:\.\d+\.[0-9a-f-]{36}\.tmp)?'$/,
				/^Retained worker write reservation [0-9a-f-]{36} release failed again: Scripted IO fault (?:e13r|e13q-(?:start|follow-up|reuse))-release-denied: (?:unlink|rename) '(?:\/harness\/agent-journey-1-system-one-(?:on|off)\/state\/orchestration\/worker-write-reservations\/|[A-Z]:\\harness\\agent-journey-1-system-one-(?:on|off)\\state\\orchestration\\worker-write-reservations\\)[0-9a-f]{64}\.json(?:\.\d+\.[0-9a-f-]{36}\.tmp)?'$/,
				// The E13H live owner's refused project release: the settled execution hands its hold and claim to the controller's retry, and
				// the base-delay alarm reports its one refused retry. Each message exactly: the agent, the refused rename of the temporary rewrite
				// of the worker conversation's metadata, with the platform root narrowed to its POSIX or drive-letter form.
				/^(?:Worker worker-\d+ resource release failed; retrying|Retained worker worker-\d+ resource release failed again): Scripted IO fault e13h-release-denied: rename '(?:\/harness\/agent-journey-1-system-one-(?:on|off)\/state\/orchestration\/sessions\/[^'/\\\n]+\/worker-conversations\/[^'/\\\n]+|[A-Z]:\\harness\\agent-journey-1-system-one-(?:on|off)\\state\\orchestration\\sessions\\[^'/\\\n]+\\worker-conversations\\[^'/\\\n]+)\.jsonl\.worker\.json\.\d+\.[0-9a-f-]{36}\.tmp'$/,
				/^Worker write reservation watcher (?:\/harness\/project|[A-Z]:\\harness\\project) teardown failed: Scripted IO fault e13j-watch-close-fails: watch\.close '(?:\/harness\/agent-journey-1-system-one-(?:on|off)\/state\/orchestration\/worker-write-reservations|[A-Z]:\\harness\\agent-journey-1-system-one-(?:on|off)\\state\\orchestration\\worker-write-reservations)'$/,
				// Terminal disclosures of the e13 worker shutdowns: each message exactly, the platform root narrowed to its POSIX or drive-letter form and
				// the reservation name to its 64-hex digest. A fault-free owner discloses none (the e13 fresh owner's control).
				/^Failed to release worker write reservation: Scripted IO fault e13-release-unlink-fails: unlink '(?:\/harness\/agent-journey-1-system-one-(?:on|off)\/state\/orchestration\/worker-write-reservations\/|[A-Z]:\\harness\\agent-journey-1-system-one-(?:on|off)\\state\\orchestration\\worker-write-reservations\\)[0-9a-f]{64}\.json'$/,
				/^Failed to release worker write reservation: Scripted IO fault e13a-release-unlink-after: unlink '(?:\/harness\/agent-journey-1-system-one-(?:on|off)\/state\/orchestration\/worker-write-reservations\/|[A-Z]:\\harness\\agent-journey-1-system-one-(?:on|off)\\state\\orchestration\\worker-write-reservations\\)[0-9a-f]{64}\.json'$/,
				/^Failed to release worker write reservation: Scripted IO fault e13j-release-unlink-fails: unlink '(?:\/harness\/agent-journey-1-system-one-(?:on|off)\/state\/orchestration\/worker-write-reservations\/|[A-Z]:\\harness\\agent-journey-1-system-one-(?:on|off)\\state\\orchestration\\worker-write-reservations\\)[0-9a-f]{64}\.json'$/,
				// Terminal disclosures of an abort-ignoring worker at close: its physical settlement bound passes with its inner calls pending, the
				// Windows shell session's terminal release bound passes before the child closes, and the task directory that System One verification
				// depends on is already disposed. Each message exactly (the attempt id narrowed to its uuid form).
				/^Worker inner completion cleanup failed: Worker worker-1 attempt attempt-[0-9a-f-]{36} physical settlement timed out after 5000ms with 2 inner call\(s\) still pending\.$/,
				/^Worker shutdown failed: Shell execution session terminal release timed out after 5000ms before child close event$/,
				/^System One verification was not run because the session was closing; no judgment was recorded\.$/,
				// The quit's bounded settle expires for a run that an extension holds past the abort (the message-end witness): exact text.
				/^A run did not settle within 5s of quit; its final message may not have been persisted\.$/,
				/^A compaction did not settle within 5s of quit; its result is discarded\.$/,
				// The refused terminal write at quit: exact text, the session path narrowed.
				/^Closing the running compaction failed at quit: Session write outcome is unknown; reconcile the original session history before retrying these messages\.$/,
				// The closing reflection witness: its held reflection is disclosed at quit, exact text.
				/^A reflection turn did not settle within 5s of quit; its work may not have been persisted\.$/,
				// Owner input queued behind a run that the quit ends is held complete with its text (the queued-quit witness): exact text.
				/^A queued message was not delivered because the session closed before it could be delivered\. It is kept in full in the pending queue: Owner input queued behind the quit\.$/,
				/^Worker worker-1 rejected: Worker worker-1 resource release failed\.$/,
				/^Failed to dispose worker write reservations: Worker write reservation shutdown failed\.$/,
				/^Worker shutdown failed: Worker worker-1 resource release failed\.$/,
				// A prompt refused by a session whose last write outcome is unknown cannot clear the restart-recovery record it just wrote.
				/^A prompt being prepared could not be recorded for restart recovery: An unresolved input's recovery record cannot be removed\.$/,
				// E13B: the held shell call outlives its 5000 ms physical join, so the owner's shutdown reports the one retained cleanup.
				/^Worker shutdown failed: Worker shutdown retained 1 physical cleanup\(s\): attempt-[0-9a-f-]+\/lease-[0-9a-f-]+\/fence-\d+\. Resources remain held; process restart may be required\.$/,
				/^Worker shutdown failed: Worker scheduler shutdown failed\.$/,
				/^Worker shutdown failed: Worker write reservation shutdown failed\.$/,
				/^Worker shutdown failed: Worker shutdown retained unresolved specialist execution resources\.$/,
				/^Worker write reservation watcher (?:\/harness\/project|[A-Z]:\\harness\\project) teardown failed: Scripted IO fault e13w-watch-close-fails: watch\.close '(?:\/harness\/agent-journey-1-system-one-(?:on|off)\/state\/orchestration\/worker-write-reservations|[A-Z]:\\harness\\agent-journey-1-system-one-(?:on|off)\\state\\orchestration\\worker-write-reservations)'$/,
				/^Worker worker-\d+ provider request failed \(server_error\); retrying in \d+s \(attempt [23]\/3\)\.$/,
				/^Worker worker-\d+ failed \(server_error\); retrying from the persisted transcript in \d+s \(attempt 2\)\.$/,
				/^A queued message was not delivered because the session context changed before it was admitted\. It is kept in full in the pending queue; restore it to the editor to send it again: Queued owner input while the summary is held\.$/,
				// The promoted directive the restart interrupts while its own turn is prepared returns to the queue held (R7): exact text.
				/^A queued message was not delivered because its turn ended before it could be delivered\. It is kept in full in the pending queue; restore it to the editor to send it again: Owner directive promoted before the cut: skip the full test suite\.$/,
				// ICM summary-settings refusals (missing summaryModel, missing egress opt-in, and a summary model without the requested thinking level): one warning each, the chat keeps running.
				/^The ICM chat needs a cheap model for its compactions, and contextPolicy\.memory\.history\.summaryModel is not set: set it to a configured model, for example "<provider>\/<model>"\. If that model is not local, also set contextPolicy\.memory\.history\.allowExternalSummaryEgress to true\.$/,
				/^The ICM chat's summary model harness-script\/worker-c is not local, and external summary egress is not allowed: set contextPolicy\.memory\.history\.allowExternalSummaryEgress to true to allow it\.$/,
				/^The ICM chat's summary model harness-script\/worker-b does not support low thinking, which its compactions request: set contextPolicy\.memory\.history\.compactionThinkingLevel to a level it supports, or contextPolicy\.memory\.history\.summaryModel to another model, for example "<provider>\/<model>"\.$/,
				// The same refusals as each refused attempt of the blocked first leaf reports them (once or twice per case, depending on arrival order).
				/^Continuous-chat compaction 0\+1 failed: The ICM chat needs a cheap model for its compactions, and contextPolicy\.memory\.history\.summaryModel is not set: set it to a configured model, for example "<provider>\/<model>"\. If that model is not local, also set contextPolicy\.memory\.history\.allowExternalSummaryEgress to true\.$/,
				/^Continuous-chat compaction 0\+1 failed: The ICM chat's summary model harness-script\/worker-c is not local, and external summary egress is not allowed: set contextPolicy\.memory\.history\.allowExternalSummaryEgress to true to allow it\.$/,
				/^Continuous-chat compaction 0\+1 failed: The ICM chat's summary model harness-script\/worker-b does not support low thinking, which its compactions request: set contextPolicy\.memory\.history\.compactionThinkingLevel to a level it supports, or contextPolicy\.memory\.history\.summaryModel to another model, for example "<provider>\/<model>"\.$/,
				// R10s: each failed attempt of the fresh chat's leaf 1 (both requests met the scripted 503): exact text.
				/^Continuous-chat compaction 1\+1 failed: Continuous-chat compaction stopped \(error\): HTTP 503 Service Unavailable: upstream overloaded$/,
				// An owner that disposes with paid usage still unconfirmed keeps it in its journal. The pending form is for a file that exists
				// with unconfirmed reports; the evidence form is only for a never-replied session whose file was never written.
				/^Usage handoff: \d+ usage report\(s\) pending in the session journal, 0 not retained, 0 confirmed row\(s\) with a journal copy left, 0 unmatched journal\(s\); none is charged to another session\.$/,
			],
			files: {
				[LIMITS_PATH]: "export const MAX_RETRIES = 3;\n",
				[projectPath("src", "features", "retry", "configuration", "limits.ts")]:
					'export const RETRY_CONFIGURATION = "long";\n',
			},
			// Guarded edge: no standing grant for destructive filesystem operations, so the operator is asked.
			settings: { edge: { allow: [] } },
		},
		async (world) => {
			await runJourney1OwnerLifecyclePhase(world);
			await runJourney1IntentAndBranchingPhase(world);
			await runJourney1ContinuousChatPhase(world);
			await runJourney1WorkerBudgetsPhase(world);
			await runJourney1WriteReservationsPhase(world);
			await runJourney1HostShutdownPhase(world);
			await verifySessionReplacementTerminalIdentity(world);
		},
	);
}
