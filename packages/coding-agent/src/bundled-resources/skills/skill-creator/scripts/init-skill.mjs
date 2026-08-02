#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ALLOWED_RESOURCES = new Set(["assets", "references", "scripts"]);

function fail(message) {
	console.error(`Error: ${message}`);
	process.exitCode = 1;
}

function parseArguments(argv) {
	const [name, ...rest] = argv;
	let outputPath;
	let description;
	let resources = [];

	for (let index = 0; index < rest.length; index++) {
		const option = rest[index];
		const value = rest[index + 1];
		if (option === "--path" || option === "--description" || option === "--resources") {
			if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
			index++;
			if (option === "--path") outputPath = value;
			if (option === "--description") description = value;
			if (option === "--resources") resources = value.split(",").filter(Boolean);
			continue;
		}

		throw new Error(`unknown option: ${option}`);
	}

	return { name, outputPath, description, resources };
}

function titleFromName(name) {
	return name
		.split("-")
		.map((part) => part[0].toUpperCase() + part.slice(1))
		.join(" ");
}

function renderSkill(name, description) {
	const title = titleFromName(name);
	const routedDescription =
		description ?? `Use when working on ${title} tasks that need a reusable, evidence-gated Pi workflow.`;

	return `---
name: ${name}
description: ${JSON.stringify(routedDescription)}
---

# ${title}

## How to use the skill

State when this skill applies, choose its mode or Freedom Dial, and name any
references or scripts that must be loaded before acting.

## North Star

Define the observable outcome, ownership boundary, and human approval edges.

## Core Sections

### 1. Establish the contract

Describe the smallest evidence-backed workflow and its required inputs.

### 2. Execute and verify

Describe the implementation loop, negative controls, and completion gate.

## Anti-Patterns

- List the shortcuts or boundary violations this skill must prevent.

## Examples

Provide one positive routing example and one adjacent negative example.

## Self-Check

- The requested outcome and validation evidence are explicit.

## Known Gaps

- Record what this skill cannot prove or perform.
`;
}

let parsed;
try {
	parsed = parseArguments(process.argv.slice(2));
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}

if (parsed) {
	const { name, outputPath, description, resources } = parsed;
	if (!name || !NAME_PATTERN.test(name) || name.length > 64) {
		fail("skill name must be 1-64 lowercase alphanumeric characters separated by single hyphens");
	} else if (!outputPath) {
		fail("--path is required");
	} else if (description !== undefined && (description.trim().length === 0 || description.length > 1000)) {
		fail("--description must contain 1-1000 characters");
	} else {
		const invalidResource = resources.find((resource) => !ALLOWED_RESOURCES.has(resource));
		if (invalidResource) {
			fail(`unsupported resource directory: ${invalidResource}`);
		} else {
			const parent = resolve(outputPath);
			mkdirSync(parent, { recursive: true });
			const canonicalParent = realpathSync(parent);
			const destination = join(canonicalParent, name);
			if (existsSync(destination)) {
				fail(`destination already exists: ${destination}`);
			} else {
				const stage = join(canonicalParent, `.pi-skill-${process.pid}-${randomUUID()}`);
				try {
					mkdirSync(stage, { mode: 0o700 });
					writeFileSync(join(stage, "SKILL.md"), renderSkill(name, description), {
						encoding: "utf8",
						flag: "wx",
						mode: 0o600,
					});
					for (const resource of [...new Set(resources)].sort()) {
						mkdirSync(join(stage, resource), { mode: 0o700 });
					}
					renameSync(stage, destination);
					console.log(`Created provider-neutral Pi skill: ${destination}`);
				} catch (error) {
					rmSync(stage, { recursive: true, force: true });
					fail(error instanceof Error ? error.message : String(error));
				}
			}
		}
	}
}
