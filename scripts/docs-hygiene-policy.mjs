#!/usr/bin/env node

import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, resolve, sep } from "node:path";

const REPOSITORY_ROOT = join(import.meta.dirname, "..");

/** Return why a path is transient and must not live under docs, or undefined when it is allowed. */
export function transientDocReason(path) {
	const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
	if (normalized === "docs/release-audit" || normalized.startsWith("docs/release-audit/")) {
		return "release and audit evidence belongs in bounded git-local storage";
	}
	if (normalized === "docs/superpowers" || normalized.startsWith("docs/superpowers/")) {
		return "agent planning/session output is transient";
	}
	if (!normalized.startsWith("docs/")) return undefined;
	const name = normalized.slice(normalized.lastIndexOf("/") + 1);
	if (/(?:^|[-_])session(?:[-_]|$)/i.test(name)) return "session-specific report is transient";
	if (/(?:^|[-_])plan(?:[-_.]|$)/i.test(name)) return "implementation plan is transient";
	if (/\d{4}-\d{2}-\d{2}/.test(name)) return "dated report is transient";
	if (/(?:^|[-_])audit(?:[-_.]|$)/i.test(name)) return "audit report is transient";
	if (/[-_]lab\.html$/i.test(name)) return "generated design lab is transient";
	return undefined;
}

export function findTransientDocs(repositoryRoot = REPOSITORY_ROOT) {
	const docsRoot = join(repositoryRoot, "docs");
	if (!existsSync(docsRoot)) return [];
	const findings = [];
	const directories = [docsRoot];
	while (directories.length > 0) {
		const directory = directories.pop();
		if (!directory) break;
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const absolute = join(directory, entry.name);
			const repositoryPath = relative(repositoryRoot, absolute).split(sep).join("/");
			const reason = transientDocReason(repositoryPath);
			if (reason) {
				findings.push({ path: repositoryPath, reason });
				continue;
			}
			if (entry.isDirectory()) directories.push(absolute);
		}
	}
	return findings.sort((left, right) => left.path.localeCompare(right.path));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const findings = findTransientDocs();
	if (findings.length > 0) {
		for (const finding of findings) console.error(`${finding.path}: ${finding.reason}`);
		console.error(`Docs hygiene failed: ${findings.length} transient path(s) found.`);
		process.exitCode = 1;
	} else {
		console.log("Docs hygiene passed: no transient audit, session, plan, or generated lab artifacts.");
	}
}
