/**
 * Value primitives of the tagged model views the host renders from its records (the tool-failure ledger, the host
 * injections in `core/comms/host-injection-records.ts`). An identifier is a bare tag when it is a plain token; every
 * free-text value is one JSON string escaped for `& < >`, so no value can end a line, open a tag or forge one.
 */

/** A plain token: rendered bare. */
const BARE_TAG = /^[A-Za-z0-9_.:/@+-]+$/;

/** Free text as one escaped JSON string: it can never end the line or open a tag. */
export function quoted(value: string): string {
	return JSON.stringify(value).replaceAll("&", "\\u0026").replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}

/** An identifier bare when it matches `bare` (a plain token by default), quoted otherwise. */
export function tag(value: string, bare: RegExp = BARE_TAG): string {
	return bare.test(value) ? value : quoted(value);
}
