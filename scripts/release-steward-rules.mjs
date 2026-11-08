/**
 * Pure rules of the release steward (scripts/release-steward.mjs). Nothing here reads the network, the
 * file system or the environment: the steward gathers facts, these functions decide. A model never supplies
 * a fact; it only answers the two advisory questions whose answers are verified here before they count.
 */

export const CHANGELOG_SECTIONS = ["Breaking Changes", "Added", "Changed", "Fixed", "Removed"];

/** Sections whose entries a breaking change may be hiding in. */
export const NON_BREAKING_SECTIONS = ["Added", "Changed", "Fixed"];

const RELEASE_SUBJECT = /^(Release|Repair release) v\d+\.\d+\.\d+$/;
const TAG_FORMAT = /^v(\d+)\.(\d+)\.(\d+)$/;
const MIN_QUOTE = 24;
const MAX_NOTES_CHARS = 3000;

export function parseTag(tag) {
	const match = TAG_FORMAT.exec(tag ?? "");
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** Highest semantic version first; tags that are not `vX.Y.Z` are ignored. */
export function sortReleaseTags(tags) {
	return tags
		.filter((tag) => parseTag(tag) !== undefined)
		.sort((a, b) => {
			const left = parseTag(a);
			const right = parseTag(b);
			for (let index = 0; index < 3; index++) {
				if (left[index] !== right[index]) return right[index] - left[index];
			}
			return 0;
		});
}

/**
 * The entries of `## [Unreleased]` per recognised `###` heading. A heading may appear more than once
 * (the changelog accumulates appended notes); every occurrence adds to the same section. An entry is a
 * top-level bullet with its continuation lines, or a bare paragraph under a heading.
 */
export function parseUnreleased(text) {
	const lines = text.split(/\r?\n/);
	const start = lines.findIndex((line) => /^## \[Unreleased\]/i.test(line));
	const sections = Object.fromEntries(CHANGELOG_SECTIONS.map((name) => [name, []]));
	if (start === -1) return { found: false, sections };
	let end = lines.findIndex((line, index) => index > start && /^## \[/.test(line));
	if (end === -1) end = lines.length;
	let current;
	let entry;
	const flush = () => {
		if (entry !== undefined && current !== undefined) sections[current].push(entry.join("\n").trim());
		entry = undefined;
	};
	for (const line of lines.slice(start + 1, end)) {
		const heading = /^###\s+(.+?)\s*$/.exec(line);
		if (heading) {
			flush();
			current = CHANGELOG_SECTIONS.find((name) => name.toLowerCase() === heading[1].toLowerCase());
			continue;
		}
		if (current === undefined) continue;
		if (!line.trim()) {
			flush();
			continue;
		}
		if (/^[-*]\s+/.test(line)) {
			flush();
			entry = [line.replace(/^[-*]\s+/, "")];
		} else if (entry !== undefined) {
			entry.push(line.trim());
		} else {
			entry = [line.trim()];
		}
	}
	flush();
	return { found: true, sections };
}

/** Text of `## [version]` up to the next `## [` heading, or "" when the changelog has no such section. */
export function extractVersionSection(text, version) {
	const lines = text.split(/\r?\n/);
	const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
	if (start === -1) return "";
	let end = lines.findIndex((line, index) => index > start && line.startsWith("## ["));
	if (end === -1) end = lines.length;
	return lines
		.slice(start + 1, end)
		.join("\n")
		.trim();
}

/** Entry counts over every package changelog: `{ total, breaking, perSection }`. */
export function countEntries(parsedChangelogs) {
	const perSection = Object.fromEntries(CHANGELOG_SECTIONS.map((name) => [name, 0]));
	for (const parsed of parsedChangelogs) {
		for (const name of CHANGELOG_SECTIONS) perSection[name] += parsed.sections[name].length;
	}
	const total = CHANGELOG_SECTIONS.reduce((sum, name) => sum + perSection[name], 0);
	return { total, breaking: perSection["Breaking Changes"], perSection };
}

/** `RELEASE_STEWARD` is an optional hard stop: only `off` (any case) stops the steward. */
export function isStewardOff(value) {
	return (value ?? "").trim().toLowerCase() === "off";
}

/**
 * The eligibility rules of a dispatch, in order. Every rule is evaluated so the summary shows the whole
 * picture; a rule whose fact could not be read fails closed. `release` needs all of them, `wouldRelease` all
 * but the mode (a dry run previews exactly the decision a live run would take).
 */
export function evaluateRules(facts) {
	const check = (id, ok, passed, failed) => ({ id, ok, reason: ok ? passed : failed });
	const ci = facts.tipCi;
	const checks = [
		check(
			"main_tip",
			facts.ref === "refs/heads/main" && facts.mainTip !== undefined && facts.sha === facts.mainTip,
			`running on main at its tip ${facts.sha}`,
			facts.mainTip === undefined
				? "the tip of main could not be read"
				: `not running at the tip of main (run on ${facts.ref} at ${facts.sha}, main is at ${facts.mainTip})`,
		),
		check(
			"ci_green",
			ci !== undefined && ci.status === "completed" && ci.conclusion === "success",
			"ci.yml concluded success on the tip",
			ci === undefined
				? "ci.yml has no readable run for the tip"
				: `ci.yml on the tip is ${ci.status === "completed" ? ci.conclusion : ci.status}, not success`,
		),
		check(
			"no_active_release_run",
			Array.isArray(facts.activeRuns) && facts.activeRuns.length === 0,
			"no release.yml or build-binaries.yml run is queued or in progress",
			Array.isArray(facts.activeRuns)
				? `a run is queued or in progress: ${facts.activeRuns.map((run) => `${run.workflow} #${run.id} (${run.status})`).join(", ")}`
				: "the active release runs could not be read",
		),
		check(
			"unreleased_entries",
			facts.entries !== undefined && facts.entries.total > 0,
			`[Unreleased] holds ${facts.entries?.total} entr${facts.entries?.total === 1 ? "y" : "ies"}`,
			"[Unreleased] holds no entry under Breaking Changes, Added, Changed, Fixed or Removed",
		),
		check(
			"tip_not_release_commit",
			facts.tipSubject !== undefined && !RELEASE_SUBJECT.test(facts.tipSubject),
			"the tip is not a release commit",
			facts.tipSubject === undefined
				? "the tip's subject could not be read"
				: `the tip is itself a release commit (${facts.tipSubject})`,
		),
		check(
			"no_prepared_untagged_release",
			facts.preparedUntagged === false,
			`no prepared but untagged release for ${facts.packageVersion}`,
			facts.preparedUntagged === undefined
				? "the release history could not be read"
				: `a release commit for ${facts.packageVersion} exists on main without its tag; resume it with the promote or repair target of release.yml, never a new patch or minor`,
		),
		check(
			"latest_tag_published",
			facts.latestTag === undefined || facts.latestTagPublished === true,
			facts.latestTag === undefined
				? "no release tag exists yet"
				: `${facts.latestTag} has a published GitHub release`,
			facts.latestTagPublished === false
				? `${facts.latestTag} has no published GitHub release; rerun its build-binaries.yml run before releasing again`
				: "the GitHub release of the latest tag could not be read",
		),
	];
	const wouldRelease = checks.every((entry) => entry.ok);
	const live = facts.inputMode === "live";
	const modeCheck = check(
		"mode_live",
		live,
		"the dispatch asked for mode=live",
		"mode=dry: the decision is reported and nothing is dispatched",
	);
	const release = wouldRelease && live;
	const all = [...checks, modeCheck];
	const reasons = release
		? all.map((entry) => entry.reason)
		: all.filter((entry) => !entry.ok).map((entry) => entry.reason);
	return { release, wouldRelease, checks: all, reasons };
}

/**
 * Names where a version stands in the prepare / promote / repair flow of scripts/release.mjs, from facts the caller read
 * (a fact it could not read is `undefined`, never a guess): `packageVersion`; `candidateOnMain` (a `Release vX` or
 * `Repair release vX` commit for it is on origin/main); `newerCommits` (commits on origin/main after that candidate);
 * `tagLocal` and `tagOnOrigin` (the `vX` tag exists there); `published` (its GitHub release is published, not a draft).
 * Pure and read-only: it names a phase and never decides an action.
 */
export function releasePhase(facts) {
	const { packageVersion, candidateOnMain, newerCommits, tagLocal, tagOnOrigin, published } = facts;
	const tag = `v${packageVersion}`;
	const phase = (id, plain) => ({ phase: id, plain });
	if (
		packageVersion === undefined ||
		candidateOnMain === undefined ||
		tagLocal === undefined ||
		tagOnOrigin === undefined
	) {
		return phase("unknown", "The package version, the release commit or the tag could not be read, so the phase is unknown.");
	}
	if ((tagOnOrigin || tagLocal) && !candidateOnMain) {
		return phase(
			"inconsistent",
			`${tag} exists but origin/main (as last fetched) has no release commit for it; fetch origin, then look at the tag before releasing again.`,
		);
	}
	if (tagOnOrigin) {
		if (published === true) return phase("assets_published", `${tag} is tagged and its GitHub release is published; the next release starts with prepare.`);
		if (published === false) {
			return phase(
				"tagged_awaiting_assets",
				`${tag} is tagged and its GitHub release is not published yet; the tag's build-binaries.yml run owns it (rerun that run if it failed, never prepare ${tag} again).`,
			);
		}
		return phase("unknown", `${tag} is tagged but its GitHub release state could not be read.`);
	}
	if (tagLocal) {
		return phase("tag_not_pushed", `${tag} exists locally but not on origin; release:promote pushes it.`);
	}
	if (candidateOnMain) {
		return newerCommits > 0
			? phase(
					"repair_candidate",
					`The release commit for ${tag} is on origin/main without its tag and ${newerCommits} later commit${newerCommits === 1 ? "" : "s"} landed; release:promote tags the candidate unchanged, release:repair folds the later notes in first.`,
				)
			: phase("prepared_untagged", `The release commit for ${tag} is on origin/main without its tag; release:promote tags it.`);
	}
	return phase("no_release_prepared", `No release commit or tag exists for ${tag}; a release starts with release:patch, release:minor or release:major.`);
}

/** `minor` when Breaking Changes has entries, else `patch` (docs: patch = fixes + additions, minor = breaking, never major). */
export function baseTarget(breakingEntries) {
	return breakingEntries > 0 ? "minor" : "patch";
}

/** The tag path's rules: the owner pushed a tag; nothing here dispatches anything. */
export function evaluateTagRules(facts) {
	const check = (id, ok, passed, failed) => ({ id, ok, reason: ok ? passed : failed });
	const tagVersion = facts.tag.slice(1);
	const checks = [
		check(
			"tag_format",
			parseTag(facts.tag) !== undefined,
			`${facts.tag} is a vX.Y.Z tag`,
			`${facts.tag} is not a vX.Y.Z release tag`,
		),
		check(
			"version_matches",
			facts.packageVersion === tagVersion,
			`packages/ai/package.json is ${tagVersion} at the tagged commit`,
			`packages/ai/package.json is ${facts.packageVersion ?? "unreadable"} at the tagged commit, not ${tagVersion}`,
		),
		check(
			"release_commit_or_on_main",
			facts.subjectMatches === true || facts.onMain === true,
			"the tagged commit is a release commit or is on main",
			"the tagged commit is neither a release commit for this version nor reachable from main",
		),
		check(
			"changelog_section",
			typeof facts.section === "string" && facts.section.length > 0,
			`the coding-agent changelog has a [${tagVersion}] section`,
			`the coding-agent changelog has no [${tagVersion}] section at the tagged commit`,
		),
		check(
			"not_already_released",
			facts.alreadyReleased === false,
			`${facts.tag} has no published GitHub release yet`,
			facts.alreadyReleased === true
				? `${facts.tag} already has a published GitHub release`
				: "the GitHub release state could not be read",
		),
	];
	const valid = checks.every((entry) => entry.ok);
	return {
		valid,
		checks,
		reasons: valid
			? checks.map((entry) => entry.reason)
			: checks.filter((entry) => !entry.ok).map((entry) => entry.reason),
	};
}

/** Strict JSON verdict of the first question; a fenced block is unwrapped, anything else that fails to parse is no answer. */
export function parseBreakingVerdict(content) {
	if (typeof content !== "string") return undefined;
	let text = content.trim();
	const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text);
	if (fenced) text = fenced[1].trim();
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (value === null || typeof value !== "object" || typeof value.breaking !== "boolean") return undefined;
	if (
		!Array.isArray(value.evidence) ||
		value.evidence.length > 20 ||
		!value.evidence.every((item) => typeof item === "string")
	) {
		return undefined;
	}
	return { breaking: value.breaking, evidence: value.evidence };
}

/**
 * A model yes only counts when it quotes a changelog entry: some evidence string of at least MIN_QUOTE
 * characters (or the whole entry when shorter) occurs verbatim inside one entry of Added, Changed or Fixed.
 */
export function verifiedBreakingEvidence(verdict, parsedChangelogs) {
	if (!verdict?.breaking) return [];
	const entries = parsedChangelogs.flatMap((parsed) => NON_BREAKING_SECTIONS.flatMap((name) => parsed.sections[name]));
	return verdict.evidence
		.map((quote) => quote.trim())
		.filter(
			(quote) =>
				quote.length > 0 &&
				entries.some((entry) => entry.includes(quote) && (quote.length >= MIN_QUOTE || quote === entry)),
		);
}

/** The release body draft goes into a public page: bounded, markdown only, no mention or link the changelog did not contain. */
export function validateNotes(draft, source) {
	if (typeof draft !== "string") return { ok: false, reason: "the model returned no text" };
	const text = draft.trim();
	if (text.length === 0) return { ok: false, reason: "the draft is empty" };
	if (text.length > MAX_NOTES_CHARS)
		return { ok: false, reason: `the draft is longer than ${MAX_NOTES_CHARS} characters` };
	if (/<\/?[a-z][^>]*>/i.test(text)) return { ok: false, reason: "the draft contains HTML" };
	const mentions = text.match(/(^|[^\w`])@[\w-]+/g) ?? [];
	if (mentions.some((mention) => !source.includes(mention.trim())))
		return { ok: false, reason: "the draft mentions an account the changelog does not" };
	const urls = text.match(/https?:\/\/[^\s)>\]]+/g) ?? [];
	if (urls.some((url) => !source.includes(url)))
		return { ok: false, reason: "the draft links a URL the changelog does not contain" };
	return { ok: true, text };
}
