import { describe, expect, it } from "vitest";
import { deriveToolkitScriptScopeKey, type EdgeGrantView } from "../src/core/autonomy/edge-policy.ts";
import { formatAuthorityContext } from "../src/core/provider-request-context-controller.ts";

describe("formatAuthorityContext", () => {
	it("projects narrow toolkit script grant with exact scopeKey and narrow disclaimer", () => {
		const grant: EdgeGrantView = {
			class: "toolkit.script",
			source: "instructions",
			scopeKey: "toolkit:safe-deploy:7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069",
			quote: "run safe-deploy with preview flag",
			grantedAt: "2026-09-12T12:00:00.000Z",
		};

		const formatted = formatAuthorityContext([grant]);

		// Narrow wording must say only exact registered script/argv authorized, never broad class
		expect(formatted).toContain("only exact registered script/argv authorized, never broad class");
		expect(formatted).toContain("scope: narrow");
		expect(formatted).toContain(
			"scopeKey: toolkit:safe-deploy:7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069",
		);
		expect(formatted).toContain('quote: "run safe-deploy with preview flag"');
		expect(formatted).toContain("grantedAt: 2026-09-12T12:00:00.000Z");

		// Negative control: must not be projected as broad class-wide authorization
		expect(formatted).not.toContain("scope: broad class-wide authorization");
	});

	it("projects broad toolkit grant as broad class-wide authorization (negative control)", () => {
		const broadGrant: EdgeGrantView = {
			class: "toolkit.script",
			source: "instructions",
			quote: "you have full permission to run any registered toolkit scripts",
		};

		const formatted = formatAuthorityContext([broadGrant]);

		// Broad wording must explicitly state broad class-wide authorization
		expect(formatted).toContain("scope: broad class-wide authorization");
		expect(formatted).toContain("toolkit.script");
		expect(formatted).toContain('quote: "you have full permission to run any registered toolkit scripts"');

		// Negative control: must not claim narrow scope or contain scopeKey
		expect(formatted).not.toContain("scope: narrow");
		expect(formatted).not.toContain("scopeKey:");
		expect(formatted).not.toContain("only exact registered script/argv authorized, never broad class");
	});

	it("projects broad non-toolkit edge grants with broad class-wide authorization", () => {
		const gitGrant: EdgeGrantView = {
			class: "git.publish",
			source: "operator",
			quote: "push to main branch after verification",
		};

		const formatted = formatAuthorityContext([gitGrant]);

		expect(formatted).toContain("git.publish");
		expect(formatted).toContain("scope: broad class-wide authorization");
		expect(formatted).not.toContain("scope: narrow");
		expect(formatted).not.toContain("scopeKey:");
	});

	it("formats real production scope key without fake derivation", () => {
		const realScopeKey = deriveToolkitScriptScopeKey({
			cwd: "/workspace/project",
			scriptPath: "scripts/db-migrate.sh",
			runner: "bash",
			scriptName: "db-migrate",
			argv: ["--target", "production", "--dry-run=false"],
		});

		const grant: EdgeGrantView = {
			class: "toolkit.script",
			source: "instructions",
			scopeKey: realScopeKey,
			quote: "run db-migrate with target production",
		};

		const formatted = formatAuthorityContext([grant]);

		expect(formatted).toContain(`scopeKey: ${realScopeKey}`);
		expect(formatted).toContain("scope: narrow (only exact registered script/argv authorized, never broad class)");
		expect(formatted).toContain('quote: "run db-migrate with target production"');
	});

	it("preserves quote length limits while retaining narrow scope and exact scopeKey", () => {
		const longQuote = "Run script. ".repeat(150); // 1800 chars > 1000 MAX_AUTHORITY_GRANT_FIELD_CHARS
		const grant: EdgeGrantView = {
			class: "toolkit.script",
			source: "instructions",
			scopeKey: "toolkit:cleanup:123456",
			quote: longQuote,
			messageEntryId: "entry-compaction-999",
		};

		const formatted = formatAuthorityContext([grant]);

		expect(formatted).toContain("scope: narrow (only exact registered script/argv authorized, never broad class)");
		expect(formatted).toContain("scopeKey: toolkit:cleanup:123456");
		expect(formatted).toContain("quote exceeds context projection capacity");
		expect(formatted).toContain("inspect durable entry entry-compaction-999");
	});
});
