import "../builtin-install.ts";
import { projectPath } from "../session-fixture.ts";
import { runJourney1ContinuousChatPhase } from "./journey-1-continuous-chat.ts";
import { runJourney1HostShutdownPhase } from "./journey-1-host-shutdown.ts";
import { runJourney1IntentAndBranchingPhase } from "./journey-1-intent-and-branching.ts";
import { runJourney1OwnerLifecyclePhase } from "./journey-1-owner-lifecycle.ts";
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
			// The E2 control's uncertain task relation emits one native warning, counted in its own block (not a broad allowance).
			// The long-path turn meets an unavailable evaluator on purpose: its owner intent stays unresolved, and only that
			// classified-as-unavailable warning is allowed.
			warningAllowances: [
				/^Optional integrations stay available; owner intent for them was not classified: Jev System One unavailable for impact 'read_only': TypeSafe HTTP 503\.$/,
				/^Optional integrations stay available; owner intent for them was not classified: the judgment was uncertain\.$/,
				/^Failed to release worker write reservation [^:]+: Scripted IO fault e13-release-rename-fails\b/,
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
				/^Closing the running compaction failed at quit: Scripted IO fault compaction-end-refused: append '(?:\/harness\/agent-journey-1-system-one-(?:on|off)\/sessions\/[^'\n]+|[A-Z]:\\harness\\agent-journey-1-system-one-(?:on|off)\\sessions\\[^'\n]+)\.jsonl'$/,
				// The closing reflection witness: its held reflection is disclosed at quit, exact text.
				/^A reflection turn did not settle within 5s of quit; its work may not have been persisted\.$/,
				// Owner input queued behind a run that the quit ends is held complete with its text (the queued-quit witness): exact text.
				/^A queued message was not delivered because the session closed before it could be delivered\. It is kept in full in the pending queue: Owner input queued behind the quit\.$/,
				/^Worker worker-1 rejected: Worker worker-1 resource release failed\.$/,
				/^Failed to dispose worker write reservations: Worker write reservation shutdown failed\.$/,
				/^Worker shutdown failed: Worker worker-1 resource release failed\.$/,
				/^Worker shutdown failed: Worker scheduler shutdown failed\.$/,
				/^Worker shutdown failed: Worker write reservation shutdown failed\.$/,
				/^Worker shutdown failed: Worker shutdown retained unresolved specialist execution resources\.$/,
				/^Worker write reservation watcher (?:\/harness\/project|[A-Z]:\\harness\\project) teardown failed: Scripted IO fault e13w-watch-close-fails: watch\.close '(?:\/harness\/agent-journey-1-system-one-(?:on|off)\/state\/orchestration\/worker-write-reservations|[A-Z]:\\harness\\agent-journey-1-system-one-(?:on|off)\\state\\orchestration\\worker-write-reservations)'$/,
				/^Worker worker-\d+ provider request failed \(server_error\); retrying in \d+s \(attempt [23]\/3\)\.$/,
				/^Worker worker-\d+ failed \(server_error\); retrying from the persisted transcript in \d+s \(attempt 2\)\.$/,
				/^A queued message was not delivered because the session context changed before it was admitted\. It is kept in full in the pending queue; restore it to the editor to send it again: Queued owner input while the summary is held\.$/,
				// ICM continuous-chat fail-closed admission checks (missing summaryModel, missing egress opt-in, and missing xhigh thinking).
				/^Memory subsystem init failed: The ICM chat needs a cheap model for its compactions, and contextPolicy\.memory\.history\.summaryModel is not set: set it to a configured model, for example "<provider>\/<model>"\. If that model is not local, also set contextPolicy\.memory\.history\.allowExternalSummaryEgress to true\.$/,
				/^Memory subsystem init failed: The ICM chat's summary model harness-script\/worker-c is not local, and external summary egress is not allowed: set contextPolicy\.memory\.history\.allowExternalSummaryEgress to true to allow it\.$/,
				/^Memory subsystem init failed: The ICM chat's summary model harness-script\/worker-b does not support xhigh thinking, which its compactions require: set contextPolicy\.memory\.history\.summaryModel to a reasoning model that supports xhigh, for example "<provider>\/<model>"\.$/,
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
		},
	);
}
