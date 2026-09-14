import assert from "node:assert/strict";
import test from "node:test";
import { prepareAdoptedChangelog } from "./release-staging.mjs";

test("adoption merges new notes into the existing untagged version without another heading or bump", () => {
	const older = "## [1.1.0] - 2026-01-01\n\n### Fixed\n\n- Older.\n";
	const source = "## [Unreleased]\n\n### Fixed\n\n- New repair.\n\n### Added\n\n- Recovery.\n\n## [1.1.1] - 2026-01-02\n\n### Fixed\n\n- Original fix.\n\n" + older;
	const adopted = prepareAdoptedChangelog(source, "1.1.1");
	assert.equal(adopted.includes("Unreleased"), false);
	assert.equal(adopted.match(/## \[1\.1\.1\]/g).length, 1);
	assert.match(adopted, /- Original fix\.\n\n- New repair\./);
	assert.match(adopted, /### Added\n\n- Recovery\./);
	assert.ok(adopted.endsWith(older));
	assert.equal(prepareAdoptedChangelog(adopted, "1.1.1"), adopted);
});

test("adoption validates the first version and rejects ambiguous or malformed notes", () => {
	assert.equal(prepareAdoptedChangelog("## [Unreleased]\n\n## [1.1.1] - 2026-01-02\n", "1.1.1"), "## [1.1.1] - 2026-01-02\n");
	for (const source of [
		"## [Unreleased]\n\n## [1.1.0]\n",
		"## [Unreleased]\n\nUnstructured note\n\n## [1.1.1]\n",
		"## [Unreleased]\n\n### Fixed\n\n- A\n\n### Fixed\n\n- B\n\n## [1.1.1]\n",
		"## [Unreleased]\n\n## [1.1.1]\n\n## [1.1.1]\n",
		"## [Unreleased]\n\n## [1.1.1]\n\n## [Unreleased]\n",
	]) assert.throws(() => prepareAdoptedChangelog(source, "1.1.1"));
});
