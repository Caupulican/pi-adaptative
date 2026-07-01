import { beforeAll, describe, expect, it } from "vitest";
import {
	decodeResourceSelection,
	detectResourceFraming,
	encodeResourceSelectionWithFraming,
} from "../src/core/profile-resource-selection.ts";
import {
	classifyResourceSource,
	ProfileResourceEditorComponent,
	resolveResourceEditPath,
} from "../src/modes/interactive/components/profile-resource-editor.ts";
import { SettingsSelectorComponent } from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => {
	initTheme("dark");
});

describe("Library Manage UX - Increment 2", () => {
	describe("Source-label classification", () => {
		const cwd = "/project/root";
		const agentDir = "/home/user/.pi/agent";
		const externalRoots = ["/catalog/path1", "/catalog/path2"];

		it("should classify paths correctly", () => {
			// catalog
			expect(classifyResourceSource("/catalog/path1/skills/my-skill", cwd, agentDir, externalRoots)).toBe("catalog");
			expect(classifyResourceSource("/catalog/path2/extensions/ext", cwd, agentDir, externalRoots)).toBe("catalog");

			// user
			expect(classifyResourceSource("/home/user/.pi/agent/skills/my-skill", cwd, agentDir, externalRoots)).toBe(
				"user",
			);

			// project
			expect(classifyResourceSource("/project/root/skills/my-skill", cwd, agentDir, externalRoots)).toBe("project");

			// bundled / default
			expect(classifyResourceSource("/some/other/path", cwd, agentDir, externalRoots)).toBe("bundled");
			expect(classifyResourceSource(undefined, cwd, agentDir, externalRoots)).toBe("bundled");
		});
	});

	describe("Allow-list vs block-list framing", () => {
		const allIds = ["read", "bash", "edit", "write"];

		it("should detect framing correctly", () => {
			expect(detectResourceFraming(undefined)).toBe("block");
			expect(detectResourceFraming({ allow: ["read"] })).toBe("allow");
			expect(detectResourceFraming({ block: ["*"] })).toBe("allow");
			expect(detectResourceFraming({ block: ["read"] })).toBe("block");
			expect(detectResourceFraming({})).toBe("block");
		});

		it("should round-trip allow-list framing", () => {
			const enabled = new Set(["read", "edit"]);
			const encoded = encodeResourceSelectionWithFraming(enabled, allIds, "allow");
			expect(encoded).toEqual({ allow: ["read", "edit"] });

			const decoded = decodeResourceSelection(encoded, allIds);
			expect(decoded).toEqual(enabled);
		});

		it("should round-trip block-list framing", () => {
			const enabled = new Set(["read", "edit", "write"]); // disabled: bash
			const encoded = encodeResourceSelectionWithFraming(enabled, allIds, "block");
			expect(encoded).toEqual({ block: ["bash"] });

			const decoded = decodeResourceSelection(encoded, allIds);
			expect(decoded).toEqual(enabled);
		});

		it("should encode empty enabled set as block: ['*'] for block framing", () => {
			const enabled = new Set<string>();
			const encoded = encodeResourceSelectionWithFraming(enabled, allIds, "block");
			expect(encoded).toEqual({ block: ["*"] });

			const decoded = decodeResourceSelection(encoded, allIds);
			expect(decoded).toEqual(enabled);
		});

		it("should encode all enabled set as undefined for block framing", () => {
			const enabled = new Set(allIds);
			const encoded = encodeResourceSelectionWithFraming(enabled, allIds, "block");
			expect(encoded).toBeUndefined();

			const decoded = decodeResourceSelection(encoded, allIds);
			expect(decoded).toEqual(enabled);
		});
	});

	describe("Missing items detection", () => {
		it("should detect and report missing items in constructor", () => {
			// Create dummy component options
			const initialResources = {
				skills: { allow: ["my-existing-skill", "my-missing-skill"] },
			};
			const kinds = [
				{
					kind: "skills" as const,
					label: "Skills",
					items: [{ id: "my-existing-skill", path: "/catalog/my-existing-skill", description: "Existing" }],
				},
			];

			const editor = new ProfileResourceEditorComponent({
				profileName: "test-profile",
				profileScope: "session",
				initialResources,
				kinds,
				onSave: () => {},
				onCancel: () => {},
			});

			// Access private missingIdsByKind via cast to any
			const missingSet = (editor as any).missingIdsByKind.get("skills");
			expect(missingSet).toBeDefined();
			expect(missingSet.has("my-missing-skill")).toBe(true);
			expect(missingSet.has("my-existing-skill")).toBe(false);

			// Under the items list we should see the missing item
			const items = (editor as any).buildItems();
			const missingItem = items.find((item: any) => item.id === "my-missing-skill");
			expect(missingItem).toBeDefined();
			expect(missingItem.isMissing).toBe(true);
		});
	});

	describe("SettingsSelector resources hub layout", () => {
		it("should render a single Resources menu item containing sub-options", () => {
			const callbacks = {
				onResourcesHubAction: () => {},
				onCancel: () => {},
			};

			const selector = new SettingsSelectorComponent(
				{
					autoCompact: true,
					showImages: false,
					imageWidthCells: 80,
					autoResizeImages: true,
					blockImages: false,
					enableSkillCommands: true,
					steeringMode: "all",
					followUpMode: "all",
					transport: "google" as any,
					httpIdleTimeoutMs: 30000,
					thinkingLevel: "off",
					availableThinkingLevels: ["off"],
					currentTheme: "dark",
					availableThemes: ["dark"],
					hideThinkingBlock: false,
					collapseChangelog: false,
					enableInstallTelemetry: false,
					doubleEscapeAction: "none",
					treeFilterMode: "default",
					showHardwareCursor: false,
					editorPaddingX: 2,
					autocompleteMaxVisible: 5,
					quietStartup: true,
					clearOnShrink: false,
					showTerminalProgress: false,
					warnings: {},
					selfModification: { enabled: false },
					autonomy: { mode: "off" },
					researchLane: {},
					modelRouter: {},
					autoLearn: { enabled: false },
					contextPolicyEnforcement: { enabled: false },
					contextMemoryRetrieval: { enabled: false },
					activeProfileName: "reviewer",
					profileOptions: [{ value: "reviewer", label: "reviewer", description: "Reviewer situation" }],
					externalResourceRoots: ["/catalog/path1"],
					trustedResourceRoots: ["/catalog/path1"],
				},
				callbacks as any,
			);

			selector.getSettingsList().handleInput("resources");
			const output = selector.render(140).join("\n");
			expect(output).toContain("Resources");
			expect(output).toContain("Manage profiles/situations, library");

			// The individual sources/profiles options should not exist in the top-level list
			expect(output).not.toContain("Sources");
		});
	});

	describe("Edit action path resolution", () => {
		it("should resolve edit path correctly for non-extensions", () => {
			expect(resolveResourceEditPath("read", undefined, "tools")).toBeUndefined();
			expect(resolveResourceEditPath("skill1", "/path/to/skill1/SKILL.md", "skills")).toBe(
				"/path/to/skill1/SKILL.md",
			);
			expect(resolveResourceEditPath("agent1", "/path/to/agent1.md", "agents")).toBe("/path/to/agent1.md");
		});

		it("should resolve extension dir index.ts/js or package.json entry", () => {
			const fs = require("node:fs");
			const path = require("node:path");
			const os = require("node:os");

			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-ext-"));
			try {
				// Case 1: index.ts exists
				const extTsDir = path.join(tempDir, "ext-ts");
				fs.mkdirSync(extTsDir);
				fs.writeFileSync(path.join(extTsDir, "index.ts"), "ts");
				expect(resolveResourceEditPath("ext-ts", extTsDir, "extensions")).toBe(path.join(extTsDir, "index.ts"));

				// Case 2: index.js exists (no index.ts)
				const extJsDir = path.join(tempDir, "ext-js");
				fs.mkdirSync(extJsDir);
				fs.writeFileSync(path.join(extJsDir, "index.js"), "js");
				expect(resolveResourceEditPath("ext-js", extJsDir, "extensions")).toBe(path.join(extJsDir, "index.js"));

				// Case 3: package.json with main exists
				const extPkgDir = path.join(tempDir, "ext-pkg");
				fs.mkdirSync(extPkgDir);
				fs.writeFileSync(path.join(extPkgDir, "package.json"), JSON.stringify({ main: "src/entry.js" }));
				const entryPath = path.join(extPkgDir, "src/entry.js");
				fs.mkdirSync(path.join(extPkgDir, "src"));
				fs.writeFileSync(entryPath, "entry");
				expect(resolveResourceEditPath("ext-pkg", extPkgDir, "extensions")).toBe(entryPath);
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});
	});

	describe("Empty/edge states", () => {
		it("should render friendly empty state message when no items exist", () => {
			const editor = new ProfileResourceEditorComponent({
				profileName: "test-profile",
				profileScope: "session",
				initialResources: {},
				kinds: [
					{
						kind: "skills",
						label: "Skills",
						items: [],
					},
				],
				onSave: () => {},
				onCancel: () => {},
			});

			const renderOutput = (editor as any).render(80).join("\n");
			expect(renderOutput).toContain("(none available — add a Source or install resources)");
		});
	});
});
