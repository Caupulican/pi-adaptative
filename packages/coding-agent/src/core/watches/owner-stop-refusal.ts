/**
 * The refusal of an arming whose call an owner's stop ended: the call began at or before a stop applied in the session, so
 * what it started is work the owner stopped, not a subject left unwatched. Typed, so the host's own arming
 * (`watch-auto-arm.ts`) tells nothing for that call, without reading the words.
 */
export class OwnerStopArmingRefusal extends Error {
	override readonly name = "OwnerStopArmingRefusal";

	constructor() {
		super("the owner's stop ended the work of the call that started it, which began before the stop");
	}
}
