/**
 * Bundled output rules: the shapes measured most often in live sessions that a line rule handles
 * well. Each rule carries its own sample so `npm run check` proves it. Add a rule here only with a
 * test; project-specific shapes belong in `.pi/output-filters.json`.
 */
import { compileOutputRulesDocument, type OutputRuleDefinition } from "./output-rules.ts";

export const BUNDLED_OUTPUT_RULE_DEFINITIONS: OutputRuleDefinition[] = [
	{
		name: "npm-install",
		match: "^(?:npm|pnpm|yarn)\\s+(?:install|i|add|ci|update|up)\\b",
		stripLinesMatching: [
			"^npm (?:warn|WARN) deprecated\\b",
			"^npm (?:warn|WARN) (?:Unknown (?:builtin|env|user|project) config|config)\\b",
			"^npm notice\\b",
			"^\\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]",
			"^\\s*(?:progress|reify|idealTree|fetchMetadata)\\b",
			"^Progress: resolved \\d+",
			"^\\s*Packages: \\+\\d+",
			"^\\s*[+]{3,}\\s*$",
			"^\\s*$",
		],
		tests: [
			{
				input: [
					"npm warn deprecated inflight@1.0.6: This module is not supported",
					"npm warn deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported",
					"npm notice New major version of npm available!",
					"",
					"added 412 packages, and audited 413 packages in 9s",
					"",
					"found 0 vulnerabilities",
					"",
				].join("\n"),
				expected: "added 412 packages, and audited 413 packages in 9s\nfound 0 vulnerabilities\n",
			},
		],
	},
	{
		name: "pip-install",
		match: "^(?:pip3?|uv pip|python3? -m pip)\\s+install\\b",
		stripLinesMatching: [
			"^Requirement already satisfied:",
			"^\\s*(?:Downloading|Using cached|Collecting|Preparing metadata|Building wheels?|Created wheel|Stored in directory|Installing collected packages|Attempting uninstall|Uninstalling|Successfully uninstalled)\\b",
			"^\\s*[━╸]+\\s",
			"^\\s*$",
		],
		tests: [
			{
				input: [
					"Collecting requests",
					"  Downloading requests-2.32.0-py3-none-any.whl (64 kB)",
					"Requirement already satisfied: idna<4,>=2.5 in ./.venv/lib (from requests) (3.7)",
					"Installing collected packages: requests",
					"Successfully installed requests-2.32.0",
					"",
				].join("\n"),
				expected: "Successfully installed requests-2.32.0\n",
			},
		],
	},
	{
		name: "docker-pull-build",
		match: "^docker\\s+(?:pull|build|compose\\s+(?:pull|build|up))\\b",
		stripLinesMatching: [
			"^[0-9a-f]{12}: (?:Pulling fs layer|Waiting|Downloading|Extracting|Verifying Checksum|Download complete|Pull complete|Already exists)",
			"^\\s*#\\d+ (?:sha256:|DONE|CACHED|extracting|resolve|transferring)",
			"^\\s*$",
		],
		tests: [
			{
				input: [
					"latest: Pulling from library/alpine",
					"4abcf2066143: Pulling fs layer",
					"4abcf2066143: Downloading",
					"4abcf2066143: Pull complete",
					"Digest: sha256:0000000000000000000000000000000000000000000000000000000000000000",
					"Status: Downloaded newer image for alpine:latest",
					"",
				].join("\n"),
				expected: [
					"latest: Pulling from library/alpine",
					"Digest: sha256:0000000000000000000000000000000000000000000000000000000000000000",
					"Status: Downloaded newer image for alpine:latest",
					"",
				].join("\n"),
			},
		],
	},
];

export const BUNDLED_OUTPUT_RULES = compileOutputRulesDocument(BUNDLED_OUTPUT_RULE_DEFINITIONS, "bundled output rules");
