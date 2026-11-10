/**
 * The text an aborted turn leaves in the conversation, and the words the screen draws for it. The text is part of the
 * transcript a model reads, so it stays English; the component that draws a stored turn recognises these texts with
 * `abortedTurnAttempts` and shows the interface's words for them, and any other error text as it is.
 */

import { englishText, type InterfaceText, interfaceText } from "../../core/language/interface-text.ts";

/** The words of an aborted turn: the conversation area. */
export type AbortedTurnWords = InterfaceText["conversation"];

/**
 * The rejection a provider reports when a request is aborted. The message travels from the provider's error, so this
 * module names it to recognise it at draw time; it is not a sentence this code writes.
 */
const REQUEST_ABORTED_TEXT = "Request was aborted";

/** The sentence an aborted turn leaves in the transcript, or the screen draws for it: the retry count picks it. */
export function abortedTurnText(attempts: number, words: AbortedTurnWords): string {
	return attempts > 0 ? words.abortedAfterRetries(attempts) : words.operationAborted;
}

/**
 * The retry count an abort text reports, `0` for a plain abort, or `undefined` when the text is not one an aborted turn
 * leaves. The English sentences are read from the catalogue's own words and then rebuilt with the count found, so this
 * module holds no second spelling of either sentence.
 */
function abortedTurnAttempts(text: string | undefined): number | undefined {
	if (text === undefined) return undefined;
	const words = englishText().conversation;
	if (text === words.operationAborted || text === REQUEST_ABORTED_TEXT) return 0;
	for (const sample of [words.abortedAfterRetries(1), words.abortedAfterRetries(2)]) {
		const digit = sample.search(/\d/u);
		if (digit < 0) continue;
		const head = sample.slice(0, digit);
		const tail = sample.slice(digit + 1);
		if (!text.startsWith(head) || !text.endsWith(tail)) continue;
		const count = text.slice(head.length, text.length - tail.length);
		if (!/^\d+$/u.test(count)) continue;
		const attempts = Number(count);
		if (abortedTurnText(attempts, words) === text) return attempts;
	}
	return undefined;
}

/** The screen's line for a stored turn that an abort ended, or `undefined` when the text reports another error. */
export function abortedTurnScreenText(errorMessage: string | undefined): string | undefined {
	const attempts = abortedTurnAttempts(errorMessage);
	return attempts === undefined ? undefined : abortedTurnText(attempts, interfaceText().conversation);
}
