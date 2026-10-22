import type { Message } from "@caupulican/pi-ai";
import type { SessionAppendIdentity } from "../kernel/session/session-append-receipt.ts";
import type { OwnerInputLedger } from "./owner-input-ledger.ts";
import { runReleaseSteps } from "./util/resource-release.ts";

interface OwnerInputPublicationDeps {
	readonly inputs: Pick<OwnerInputLedger, "notePersisted" | "noteUncertain">;
	noteEvidence(message: Message, entryId: string): void;
	protectRecovery(sessionFile: string | undefined): void;
	queueChanged(): void;
}

/** Coordinates independent effects without allowing one failed observer to suppress the others. */
export function createOwnerInputPublicationObserver(deps: OwnerInputPublicationDeps) {
	return {
		persisted: (message: Message, entryId: string, publication: SessionAppendIdentity): void =>
			runReleaseSteps(
				[() => deps.noteEvidence(message, entryId), () => deps.inputs.notePersisted(message, entryId, publication)],
				"Owner input persistence notifications failed.",
			),
		uncertain: (message: Message, entryId: string, publication: SessionAppendIdentity): void =>
			runReleaseSteps(
				[
					() => deps.protectRecovery(publication.sessionFile),
					() => deps.inputs.noteUncertain(message, entryId, publication),
					() => deps.queueChanged(),
				],
				"Uncertain owner input notification failed.",
			),
	};
}
