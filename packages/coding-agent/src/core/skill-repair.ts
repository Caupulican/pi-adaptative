import { createHash } from "node:crypto";
import { type Stats, statSync } from "node:fs";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import {
	MAX_ACTIVE_SKILL_BODY_BYTES,
	MAX_SKILL_DESCRIPTION_LENGTH,
	MAX_SKILL_FRONTMATTER_BYTES,
	type SkillFrontmatter,
} from "./skills.ts";
import { writeFileAtomicSync } from "./util/atomic-file.ts";
import { readBoundedTextFileSync } from "./util/bounded-file.ts";

export interface SkillInspectSuccess {
	ok: true;
	name: string;
	description: string;
	body: string;
	version: string;
	filePath: string;
}

export type SkillInspectResult =
	| SkillInspectSuccess
	| { ok: false; reason: "not_found" | "read_failed"; message: string };

export interface SkillRepairSuccess {
	ok: true;
	name: string;
	filePath: string;
	version: string;
}

export type SkillRepairResult =
	| SkillRepairSuccess
	| {
			ok: false;
			reason:
				| "invalid_body"
				| "body_too_large"
				| "not_found"
				| "stale_source"
				| "write_failed"
				| "evolution_disallowed";
			message: string;
	  };

export interface SkillRepairInput {
	name: string;
	body: string;
	expectedVersion: string;
	description?: string;
}

export function computeSkillDigest(raw: string): string {
	return createHash("sha256").update(raw, "utf8").digest("hex");
}

/**
 * Bounded read and version extraction for inspection without activating or loading into slots.
 */
export function inspectSkillFile(filePath: string, name: string): SkillInspectResult {
	let stat: Stats;
	try {
		stat = statSync(filePath);
	} catch (error) {
		return {
			ok: false,
			reason: "read_failed",
			message: `Failed to stat skill file: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	let raw: string;
	try {
		raw = readBoundedTextFileSync(
			filePath,
			MAX_ACTIVE_SKILL_BODY_BYTES + MAX_SKILL_FRONTMATTER_BYTES,
			`Skill ${JSON.stringify(name)}`,
		);
	} catch (error) {
		return {
			ok: false,
			reason: "read_failed",
			message: `Failed to read skill file: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const parsed = parseFrontmatter<SkillFrontmatter>(raw);
	const digest = computeSkillDigest(raw);
	const version = `${stat.mtimeMs}:${digest}`;
	return {
		ok: true,
		name,
		description: parsed.frontmatter.description ?? "",
		body: parsed.body,
		version,
		filePath,
	};
}

/**
 * Atomic repair write with frontmatter preservation and stale-source check.
 *
 * Reads current bytes and verifies the exact opaque source version before atomic write.
 * Note: A residual OS-level concurrent-writer race window exists between stat/read and atomic write
 * without cooperative kernel-level file locks, but atomic file replacement ensures no partial writes.
 */
export function repairSkillFile(
	filePath: string,
	input: SkillRepairInput,
	fallbackDescription?: string,
): SkillRepairResult {
	const trimmedBody = input.body.trim();
	if (!trimmedBody) {
		return { ok: false, reason: "invalid_body", message: "Skill repair requires body content." };
	}
	const bodyBytes = Buffer.byteLength(trimmedBody, "utf8");
	if (bodyBytes > MAX_ACTIVE_SKILL_BODY_BYTES) {
		return {
			ok: false,
			reason: "body_too_large",
			message: `Repaired skill body exceeds ${MAX_ACTIVE_SKILL_BODY_BYTES} bytes.`,
		};
	}
	let currentStat: Stats;
	try {
		currentStat = statSync(filePath);
	} catch (error) {
		return {
			ok: false,
			reason: "write_failed",
			message: `Failed to stat skill file: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	let raw: string;
	try {
		raw = readBoundedTextFileSync(
			filePath,
			MAX_ACTIVE_SKILL_BODY_BYTES + MAX_SKILL_FRONTMATTER_BYTES,
			`Skill ${JSON.stringify(input.name)}`,
		);
	} catch (error) {
		return {
			ok: false,
			reason: "write_failed",
			message: `Failed to read skill file: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const currentDigest = computeSkillDigest(raw);
	const currentVersion = `${currentStat.mtimeMs}:${currentDigest}`;

	if (input.expectedVersion !== currentVersion) {
		return {
			ok: false,
			reason: "stale_source",
			message: `Skill source has changed on disk since last read (expected version ${JSON.stringify(input.expectedVersion)}, found ${JSON.stringify(currentVersion)}).`,
		};
	}

	const parsed = parseFrontmatter<SkillFrontmatter>(raw);
	const description = input.description?.trim() || parsed.frontmatter.description || fallbackDescription || "";
	if (description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
		return {
			ok: false,
			reason: "invalid_body",
			message: `Repaired skill description exceeds ${MAX_SKILL_DESCRIPTION_LENGTH} characters.`,
		};
	}

	const frontmatterObj: Record<string, unknown> = {
		...parsed.frontmatter,
		name: input.name,
		description,
	};
	const frontmatterLines = [
		"---",
		...Object.entries(frontmatterObj).map(([key, val]) => `${key}: ${JSON.stringify(val)}`),
		"---",
	];
	const frontmatterText = frontmatterLines.join("\n");
	const frontmatterBytes = Buffer.byteLength(frontmatterText, "utf8");
	if (frontmatterBytes > MAX_SKILL_FRONTMATTER_BYTES) {
		return {
			ok: false,
			reason: "invalid_body",
			message: `Repaired skill frontmatter exceeds ${MAX_SKILL_FRONTMATTER_BYTES} bytes.`,
		};
	}

	const newContent = `${frontmatterText}\n\n${trimmedBody}\n`;
	const totalBytes = Buffer.byteLength(newContent, "utf8");
	if (totalBytes > MAX_ACTIVE_SKILL_BODY_BYTES + MAX_SKILL_FRONTMATTER_BYTES) {
		return {
			ok: false,
			reason: "body_too_large",
			message: `Repaired skill file exceeds ${MAX_ACTIVE_SKILL_BODY_BYTES + MAX_SKILL_FRONTMATTER_BYTES} bytes.`,
		};
	}

	try {
		writeFileAtomicSync(filePath, newContent);
		const newStat = statSync(filePath);
		const newDigest = computeSkillDigest(newContent);
		return { ok: true, name: input.name, filePath, version: `${newStat.mtimeMs}:${newDigest}` };
	} catch (error) {
		return {
			ok: false,
			reason: "write_failed",
			message: `Failed to write skill file: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}
