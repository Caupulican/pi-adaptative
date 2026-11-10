/**
 * What a credential assessment says about a call's output, and the mask each answer picks for the whole text, for a
 * fragment of it, and for the output file the call saves.
 */
import { redactKnownSecrets } from "../security/secret-text.ts";
import { SOURCE_SCAN_START, type SourceDialect } from "../security/source-scanner.ts";
import {
	type CredentialBlockMaskKind,
	mockCredentialContent,
	mockCredentialFields,
	mockProtectedSearchLines,
} from "./credential-content-mock.ts";
import type { CredentialPathPolicy } from "./credential-path-policy.ts";
import { maskSourceText } from "./source-mask.ts";

/**
 * What a credential assessment says about the text a call returns, which decides its mask: `none` is ordinary output
 * (the name rule), `content` masks every line, `search` the lines of protected files, `source` is one whole
 * program source file printed from its first line, whose `dialect` says how to read it, `sections` was masked section
 * by section by the calls that produced it (a `lookup`).
 */
export type ExposureTextKind = "none" | "search" | "content" | "source" | "sections";

export interface ExposureMock {
	/** The mask of a result text that holds the call's whole output from its first line. */
	readonly text: (text: string) => string;
	/** The mask of every other text of the call: a streamed update, a detail, a result that was cut or reduced. */
	readonly fragment: (text: string) => string;
	/** The mask of the output file the call saves, block by block. */
	readonly kind: CredentialBlockMaskKind;
}

/** A mask that reads each line on its own: a fragment of the text is read exactly as the whole of it is. */
function readsLinesAlone(mask: (text: string) => string, kind: CredentialBlockMaskKind): ExposureMock {
	return { text: mask, fragment: mask, kind };
}

/** The mask for one result; `paths` is asked only by the kind that judges the files a line names. */
export function createExposureMock(
	kind: ExposureTextKind,
	paths: () => CredentialPathPolicy,
	dialect?: SourceDialect,
	numbered = false,
): ExposureMock {
	switch (kind) {
		case "content":
			return readsLinesAlone(mockCredentialContent, { kind: "content" });
		case "source":
			if (dialect === undefined) return readsLinesAlone(mockCredentialFields, { kind: "fields" });
			// Program source is source only as a whole text: a fragment may start inside a literal or a comment.
			return {
				text: (text) => maskSourceText(text, dialect, SOURCE_SCAN_START, numbered),
				fragment: mockCredentialFields,
				kind: { kind: "source", dialect, numbered },
			};
		case "sections":
			return readsLinesAlone(redactKnownSecrets, { kind: "shapes" });
		case "search": {
			const policy = paths();
			const isProtectedPath = (path: string) => policy.isProtected(path);
			return readsLinesAlone((text) => mockProtectedSearchLines(text, isProtectedPath), {
				kind: "search",
				isProtectedPath,
			});
		}
		case "none":
			return readsLinesAlone(mockCredentialFields, { kind: "fields" });
	}
}

/** The mask of an error a call throws: an error text is never program source, whatever the result kind is. */
export function errorMaskFor(): (text: string) => string {
	return mockCredentialFields;
}
