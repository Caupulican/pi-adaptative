/**
 * A text file never contains U+0000. When one reaches disk through `edit` or `write` the file stops
 * being text: git reports it as binary, every importer and diff tool breaks, and the corruption is
 * invisible in a terminal because a NUL renders as nothing. The byte has been observed arriving from
 * an editing model as a mutated space next to multi-byte characters, so it is a transport defect in
 * the replacement, not content the caller meant to write.
 *
 * The guard therefore runs in each tool's validation phase, before the mutation queue, before any
 * read and before any write, and refuses. It never repairs the string: stripping the NUL would guess
 * which character the caller meant, and a silent guess is how a corrupted space becomes a corrupted
 * file. A file that legitimately holds NULs stays editable, because `edit` only refuses a
 * replacement whose matching `oldText` has none (see {@link findEditNulViolation}).
 */

/** The code point no text file may carry, built at runtime so this source stays NUL-free. */
const NUL = String.fromCharCode(0);
const DELETE_CODE = 0x7f;
const LAST_C0_CODE = 0x1f;

/** Stable marker for the `nul_in_replacement` diagnostic; matched by the tool-repair registry. */
export const NUL_IN_REPLACEMENT_MARKER = "PI_NUL_IN_REPLACEMENT";
/** Stable marker for the `nul_in_content` diagnostic; matched by the tool-repair registry. */
export const NUL_IN_CONTENT_MARKER = "PI_NUL_IN_CONTENT";

/** Characters of surrounding text quoted on each side of the offending code point. */
const NUL_CONTEXT_CHARACTERS = 20;

const CONTROL_ESCAPES: ReadonlyMap<string, string> = new Map([
	[NUL, "\\x00"],
	["\n", "\\n"],
	["\r", "\\r"],
	["\t", "\\t"],
]);

/** Renders control characters so the diagnostic stays one readable line, NUL as `\x00` (never `\0`, which reads as octal before a digit). */
function escapeControlCharacters(text: string): string {
	let escaped = "";
	for (const character of text) {
		const code = character.codePointAt(0) ?? 0;
		if (code > LAST_C0_CODE && code !== DELETE_CODE) {
			escaped += character;
			continue;
		}
		escaped += CONTROL_ESCAPES.get(character) ?? `\\x${code.toString(16).padStart(2, "0")}`;
	}
	return escaped;
}

/**
 * Offset of the first U+0000 counted in characters (code points), or -1 when the text holds none.
 * A code-unit index would drift from what the caller can count whenever the text carries astral
 * characters, which is exactly the neighbourhood this corruption appears in.
 */
export function findNulCharacterOffset(text: string): number {
	const unitIndex = text.indexOf(NUL);
	if (unitIndex === -1) return -1;
	let offset = 0;
	for (const _character of text.slice(0, unitIndex)) offset++;
	return offset;
}

/** `NUL_CONTEXT_CHARACTERS` code points on each side of the offending one, controls escaped. */
export function describeNulContext(text: string, characterOffset: number): string {
	const characters = [...text];
	const start = Math.max(0, characterOffset - NUL_CONTEXT_CHARACTERS);
	const end = Math.min(characters.length, characterOffset + NUL_CONTEXT_CHARACTERS + 1);
	const prefix = start > 0 ? "..." : "";
	const suffix = end < characters.length ? "..." : "";
	return `${prefix}${escapeControlCharacters(characters.slice(start, end).join(""))}${suffix}`;
}

/** One replacement carrying a NUL its anchor does not, with the edit's 1-based position. */
export interface EditNulViolation {
	/** 1-based index of the offending edit within the call's `edits` array. */
	index: number;
	/** Character (code point) offset of the first U+0000 inside `newText`. */
	characterOffset: number;
	context: string;
}

/**
 * First replacement that introduces a NUL the edit's own anchor does not already carry. An edit
 * whose `oldText` also holds U+0000 is matching real NUL-bearing source, so it is left alone.
 */
export function findEditNulViolation(
	edits: readonly { oldText: string; newText: string }[],
): EditNulViolation | undefined {
	for (let index = 0; index < edits.length; index++) {
		const edit = edits[index];
		const characterOffset = findNulCharacterOffset(edit.newText);
		if (characterOffset === -1 || edit.oldText.includes(NUL)) continue;
		return { index: index + 1, characterOffset, context: describeNulContext(edit.newText, characterOffset) };
	}
	return undefined;
}

/** Refuses before the mutation queue: no lease is taken, nothing is read and nothing is written. */
export function assertNoNulInEditReplacements(edits: readonly { oldText: string; newText: string }[]): void {
	const violation = findEditNulViolation(edits);
	if (!violation) return;
	throw new Error(
		`${NUL_IN_REPLACEMENT_MARKER}: Edit ${violation.index} has U+0000 (NUL) in newText at character offset ${violation.characterOffset}: "${violation.context}". Text files never contain NUL, so this is a corrupted character in the replacement, not source text; no file was read and no write was attempted. Re-send edit ${violation.index} with the same replacement without the U+0000 character, restoring whatever character it replaced; never write the file through bash or python instead.`,
	);
}

/** Refuses before the file is created: `write` produces text files, binaries go through bash/python. */
export function assertNoNulInWriteContent(content: string): void {
	const characterOffset = findNulCharacterOffset(content);
	if (characterOffset === -1) return;
	throw new Error(
		`${NUL_IN_CONTENT_MARKER}: write content has U+0000 (NUL) at character offset ${characterOffset}: "${describeNulContext(content, characterOffset)}". Text files never contain NUL, so this is a corrupted character in the content, not text to store; no file was created. Re-send the same content without the U+0000 character, restoring whatever character it replaced; never create the file through bash or python instead.`,
	);
}
