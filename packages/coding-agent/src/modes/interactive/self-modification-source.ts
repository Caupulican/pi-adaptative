/**
 * Whether the self-modification source can be edited: the paths the settings name, resolved against the working folder,
 * and the sentence the settings screen shows when none of them is a pi-adaptative checkout.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { interfaceText } from "../../core/language/interface-text.ts";
import type { SelfModificationSettings } from "../../core/settings/settings-schema.ts";
import { collectSelfModificationSourceCandidates } from "../../core/system-prompt-builder.ts";
import { resolvePath } from "../../utils/paths.ts";

/** The reason the source cannot be edited, or nothing when one of the candidates is a pi-adaptative checkout. */
export function describeSelfModificationSourceProblem(
	settings: SelfModificationSettings,
	cwd: string,
): string | undefined {
	const words = interfaceText().interactive;
	if (!settings.enabled) return undefined;
	const resolved = collectSelfModificationSourceCandidates(settings).map((candidate) =>
		resolvePath(candidate, cwd, { trim: true }),
	);
	if (resolved.length === 0) return words.selfModificationNoSource;
	const valid = resolved.find(
		(candidate) =>
			fs.existsSync(candidate) &&
			fs.existsSync(path.join(candidate, "package.json")) &&
			fs.existsSync(path.join(candidate, "packages", "coding-agent")),
	);
	if (valid) return undefined;
	const first = resolved[0];
	if (!fs.existsSync(first)) return words.selfModificationSourceMissing(first);
	if (!fs.existsSync(path.join(first, "package.json"))) return words.selfModificationNoPackageJson(first);
	return words.selfModificationNotPiAdaptative(first);
}
