#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REQUIRED_HEADERS = [
	"## How to use the skill",
	"## North Star",
	"## Core Sections",
	"## Anti-Patterns",
	"## Examples",
	"## Self-Check",
	"## Known Gaps",
];

function parseFrontmatter(content, errors) {
	const normalized = content.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---\n")) {
		errors.push("SKILL.md must start with YAML frontmatter");
		return {};
	}

	const end = normalized.indexOf("\n---\n", 4);
	if (end < 0) {
		errors.push("SKILL.md frontmatter is not closed");
		return {};
	}

	const fields = new Map();
	for (const line of normalized.slice(4, end).split("\n")) {
		const separator = line.indexOf(":");
		if (separator < 1) continue;
		const key = line.slice(0, separator).trim();
		const value = line.slice(separator + 1).trim();
		if (fields.has(key)) errors.push(`frontmatter field is duplicated: ${key}`);
		fields.set(key, value);
	}

	return { name: fields.get("name"), description: fields.get("description") };
}

function validateResourceLinks(skillDirectory, content, errors) {
	const linkPattern = /\]\((?:\.\/)?((?:scripts|references|assets)\/[^)#?]+)(?:[?#][^)]*)?\)/g;
	for (const match of content.matchAll(linkPattern)) {
		const linked = match[1];
		if (!linked || isAbsolute(linked)) {
			errors.push(`resource link must be relative: ${linked ?? ""}`);
			continue;
		}

		const destination = resolve(skillDirectory, normalize(linked));
		const escaped = relative(skillDirectory, destination);
		if (escaped === ".." || escaped.startsWith(`..${sep}`)) {
			errors.push(`resource link escapes the skill directory: ${linked}`);
		} else if (!existsSync(destination)) {
			errors.push(`linked resource does not exist: ${linked}`);
		}
	}
}

const argument = process.argv[2];
if (!argument || process.argv.length !== 3) {
	console.error("Usage: node validate-skill.mjs <skill-directory>");
	process.exitCode = 1;
} else {
	const skillDirectory = resolve(argument);
	const errors = [];
	if (!existsSync(skillDirectory) || !lstatSync(skillDirectory).isDirectory()) {
		errors.push(`skill directory does not exist: ${skillDirectory}`);
	} else {
		const skillPath = join(skillDirectory, "SKILL.md");
		if (!existsSync(skillPath) || !lstatSync(skillPath).isFile()) {
			errors.push("SKILL.md is missing");
		} else {
			const content = readFileSync(skillPath, "utf8");
			const lineCount = content.split(/\r?\n/).length;
			if (lineCount >= 500) errors.push(`SKILL.md must be under 500 lines; found ${lineCount}`);

			const frontmatter = parseFrontmatter(content, errors);
			if (!frontmatter.name || !NAME_PATTERN.test(frontmatter.name) || frontmatter.name.length > 64) {
				errors.push("name must be 1-64 lowercase alphanumeric characters separated by single hyphens");
			} else if (frontmatter.name !== basename(skillDirectory)) {
				errors.push(`frontmatter name must match directory name: ${basename(skillDirectory)}`);
			}

			if (!frontmatter.description || !/^"(?:[^"\\]|\\.)+"$/.test(frontmatter.description)) {
				errors.push("description must be a quoted YAML string");
			} else {
				try {
					const description = JSON.parse(frontmatter.description);
					if (typeof description !== "string" || description.length === 0 || description.length > 1000) {
						errors.push("description must contain 1-1000 characters");
					}
				} catch {
					errors.push("description must be a valid double-quoted YAML string");
				}
			}

			let previous = -1;
			for (const header of REQUIRED_HEADERS) {
				const index = content.indexOf(header);
				if (index < 0) errors.push(`required header is missing: ${header}`);
				else if (index <= previous) errors.push(`required header is out of order: ${header}`);
				previous = Math.max(previous, index);
			}

			validateResourceLinks(skillDirectory, content, errors);
		}

		if (existsSync(join(skillDirectory, "agents", "openai.yaml"))) {
			errors.push("provider-specific agents/openai.yaml is not allowed in bundled Pi skills");
		}
	}

	if (errors.length > 0) {
		for (const error of errors) console.error(`Error: ${error}`);
		process.exitCode = 1;
	} else {
		console.log(`Skill is valid: ${skillDirectory}`);
	}
}
