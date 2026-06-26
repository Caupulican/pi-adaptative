import { isAbsolute, resolve } from "node:path";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	Key,
	matchesKey,
	Spacer,
	Text,
} from "@caupulican/pi-tui";
import {
	decodeResourceSelection,
	detectResourceFraming,
	encodeResourceSelectionWithFraming,
	type ResourceFraming,
} from "../../../core/profile-resource-selection.ts";
import type { ResourceProfileKind, ResourceProfileSettings } from "../../../core/settings-manager.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyText } from "./keybinding-hints.ts";

export interface ProfileResourceItem {
	id: string;
	path?: string;
	description?: string;
}

export interface ProfileResourceEditorKind {
	kind: ResourceProfileKind; // "tools" | "skills" | "extensions" | "agents" | "prompts" | "themes"
	label: string; // display label, e.g. "Tools"
	items: ProfileResourceItem[]; // the available items of this kind
}

export interface ProfileResourceEditorOptions {
	profileName: string;
	profileScope: string; // e.g. "directory" | "project" | "global" | "session" | "reusable-file"
	initialResources: ResourceProfileSettings; // existing profile.resources; may be {}
	kinds: ProfileResourceEditorKind[]; // the six kinds, with their universes
	onSave: (resources: ResourceProfileSettings) => void; // called on ctrl+s with the encoded result
	onCancel: () => void; // called on esc
	onScopeChange?: () => void;
	cwd?: string;
	agentDir?: string;
	externalResourceRoots?: string[];
}

interface ResourceItem {
	id: string;
	enabled: boolean;
	path?: string;
	description?: string;
	sourceLabel?: "catalog" | "user" | "project" | "bundled";
	isMissing?: boolean;
}

const TOOL_DESCRIPTIONS: Record<string, string> = {
	read: "Read files from the filesystem.",
	bash: "Execute arbitrary commands in the shell.",
	edit: "Edit files surgically.",
	write: "Create new files or overwrite existing files.",
	grep: "Search for text patterns using ripgrep.",
	find: "Locate files matching a search query.",
	ls: "List files and directories.",
	skill_audit: "Inspect and audit local skills.",
	skillify: "Convert a set of files/instructions into a skill.",
	extensionify: "Package a tool or script as an extension.",
};

export function classifyResourceSource(
	filePath: string | undefined,
	cwd: string,
	agentDir: string,
	externalRoots: string[],
): "catalog" | "user" | "project" | "bundled" {
	if (!filePath) {
		return "bundled";
	}

	const absolutePath = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
	const normPath = resolve(absolutePath);
	const normCwd = resolve(cwd);
	const normAgentDir = agentDir ? resolve(agentDir) : "";

	for (const extRoot of externalRoots) {
		const normExt = resolve(extRoot);
		if (normPath.startsWith(normExt)) {
			return "catalog";
		}
	}

	if (normAgentDir && normPath.startsWith(normAgentDir)) {
		return "user";
	}

	if (normPath.startsWith(normCwd)) {
		return "project";
	}

	if (normPath.includes("node_modules")) {
		return "bundled";
	}

	return "bundled";
}

export class ProfileResourceEditorComponent extends Container implements Focusable {
	private profileName: string;
	private profileScope: string;
	private kinds: ProfileResourceEditorKind[];
	private enabledByKind: Map<ResourceProfileKind, Set<string>> = new Map();
	private framingByKind: Map<ResourceProfileKind, ResourceFraming> = new Map();
	private missingIdsByKind: Map<ResourceProfileKind, Set<string>> = new Map();
	private currentKindIndex = 0;

	private cwd: string;
	private agentDir: string;
	private externalResourceRoots: string[];

	private filteredItems: ResourceItem[] = [];
	private selectedIndex = 0;
	private searchInput: Input;
	private kindHeaderText: Text;
	private listContainer: Container;
	private descriptionText: Text;
	private footerText: Text;
	private isDirty = false;
	private maxVisible = 8;

	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	private onSave: (resources: ResourceProfileSettings) => void;
	private onCancel: () => void;
	private onScopeChange?: () => void;

	constructor(options: ProfileResourceEditorOptions) {
		super();
		this.profileName = options.profileName;
		this.profileScope = options.profileScope;
		this.kinds = options.kinds;
		this.onSave = options.onSave;
		this.onCancel = options.onCancel;
		this.onScopeChange = options.onScopeChange;
		this.cwd = options.cwd || process.cwd();
		this.agentDir = options.agentDir || "";
		this.externalResourceRoots = options.externalResourceRoots || [];

		// Initialize enabled, framing, and missing sets for each kind
		for (const kind of this.kinds) {
			const filter = options.initialResources[kind.kind];
			const allIds = kind.items.map((item) => item.id);
			const enabledSet = decodeResourceSelection(filter, allIds);
			this.enabledByKind.set(kind.kind, enabledSet);
			this.framingByKind.set(kind.kind, detectResourceFraming(filter));

			// Compute missing items
			const mentionedIds = new Set<string>();
			if (filter) {
				if (filter.allow) {
					for (const id of filter.allow) {
						mentionedIds.add(id);
					}
				}
				if (filter.block) {
					for (const id of filter.block) {
						if (id !== "*") {
							mentionedIds.add(id);
						}
					}
				}
			}
			const availableIds = new Set(allIds);
			const missingSet = new Set<string>();
			for (const id of mentionedIds) {
				if (!availableIds.has(id)) {
					missingSet.add(id);
				}
			}
			this.missingIdsByKind.set(kind.kind, missingSet);
		}

		// Header
		this.addChild(new DynamicBorder());
		this.addChild(
			new Text(
				theme.fg("accent", theme.bold(`Library — editing "${this.profileName}" (${this.profileScope})`)),
				0,
				0,
			),
		);
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					`Navigate kinds: ${keyText("tui.input.tab")}. Toggle: ${keyText("tui.select.confirm")}. Mode: ${theme.fg("accent", "a")} allow / ${theme.fg("accent", "b")} block. Scope: ${theme.fg("accent", "s")} change.`,
				),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));

		// Kind selector header
		this.kindHeaderText = new Text(this.getKindHeaderText(), 0, 0);
		this.addChild(this.kindHeaderText);
		this.addChild(new Spacer(1));

		// Search input
		this.searchInput = new Input();
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		// List container
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		// Description area
		this.descriptionText = new Text("", 0, 0);
		this.addChild(new Spacer(1));
		this.addChild(this.descriptionText);

		// Footer hint
		this.addChild(new Spacer(1));
		this.footerText = new Text(this.getFooterText(), 0, 0);
		this.addChild(this.footerText);

		this.addChild(new DynamicBorder());

		this.refresh();
	}

	private getKindHeaderText(): string {
		const kind = this.kinds[this.currentKindIndex]!;
		const enabledSet = this.enabledByKind.get(kind.kind)!;
		const framing = this.framingByKind.get(kind.kind)!;
		const framingText = framing === "allow" ? "allow-list" : "block-list";
		const countText = `${enabledSet.size}/${kind.items.length} enabled (${framingText})`;
		const kindIndicator = this.kinds
			.map((k, i) => {
				const marker = i === this.currentKindIndex ? "●" : "○";
				return theme.fg(i === this.currentKindIndex ? "accent" : "muted", `${marker} ${k.label}`);
			})
			.join(" ");
		return `${kindIndicator}  ${theme.fg("muted", countText)}`;
	}

	private getCurrentKind(): ProfileResourceEditorKind {
		return this.kinds[this.currentKindIndex]!;
	}

	private getCurrentEnabledSet(): Set<string> {
		const kind = this.getCurrentKind();
		return this.enabledByKind.get(kind.kind)!;
	}

	private buildItems(): ResourceItem[] {
		const kind = this.getCurrentKind();
		const enabledSet = this.getCurrentEnabledSet();

		const items: ResourceItem[] = [];

		// Add all available items
		for (const availableItem of kind.items) {
			const isEnabled = enabledSet.has(availableItem.id);
			let desc = availableItem.description;
			if (kind.kind === "tools" && !desc) {
				desc = TOOL_DESCRIPTIONS[availableItem.id];
			}
			items.push({
				id: availableItem.id,
				enabled: isEnabled,
				path: availableItem.path,
				description: desc,
				sourceLabel: classifyResourceSource(
					availableItem.path,
					this.cwd,
					this.agentDir,
					this.externalResourceRoots,
				),
				isMissing: false,
			});
		}

		// Add missing items
		const missingSet = this.missingIdsByKind.get(kind.kind) || new Set<string>();
		for (const missingId of missingSet) {
			const isEnabled = enabledSet.has(missingId);
			items.push({
				id: missingId,
				enabled: isEnabled,
				isMissing: true,
				description: "Referenced in profile but missing from available resources.",
			});
		}

		// Sort: enabled first, then disabled
		const enabled: ResourceItem[] = [];
		const disabled: ResourceItem[] = [];
		for (const item of items) {
			if (item.enabled) {
				enabled.push(item);
			} else {
				disabled.push(item);
			}
		}
		return [...enabled, ...disabled];
	}

	private getFooterText(): string {
		const kind = this.getCurrentKind();
		const enabledSet = this.getCurrentEnabledSet();
		const countText = `${enabledSet.size}/${kind.items.length} enabled`;
		const parts = [
			`${keyText("tui.select.confirm")} toggle`,
			`${keyText("tui.input.tab")} kind`,
			`${keyText("app.models.save")} save`,
			countText,
		];
		return this.isDirty
			? theme.fg("dim", `  ${parts.join(" · ")} `) + theme.fg("warning", "(unsaved)")
			: theme.fg("dim", `  ${parts.join(" · ")}`);
	}

	private refresh(): void {
		const query = this.searchInput.getValue();
		const items = this.buildItems();
		this.filteredItems = query ? fuzzyFilter(items, query, (i) => `${i.id} ${i.description ?? ""}`) : items;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredItems.length - 1));
		this.updateList();
		this.footerText.setText(this.getFooterText());
	}

	private updateList(): void {
		this.listContainer.clear();

		if (this.filteredItems.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "  No matching resources"), 0, 0));
			this.descriptionText.setText(theme.fg("muted", "  No description available"));
			return;
		}

		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);

		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredItems[i]!;
			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
			let resourceText = isSelected ? theme.fg("accent", item.id) : item.id;

			if (item.isMissing) {
				resourceText = theme.fg("muted", `${item.id} [missing]`);
			} else if (item.sourceLabel) {
				const labelColor =
					item.sourceLabel === "catalog"
						? "thinkingText"
						: item.sourceLabel === "project"
							? "success"
							: item.sourceLabel === "user"
								? "warning"
								: "muted";
				const labelText = theme.fg(labelColor, ` [${item.sourceLabel}]`);
				resourceText = `${resourceText}${labelText}`;
			}

			const status = item.enabled ? theme.fg("success", " ✓") : theme.fg("dim", " ✗");
			this.listContainer.addChild(new Text(`${prefix}${resourceText}${status}`, 0, 0));
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			this.listContainer.addChild(
				new Text(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredItems.length})`), 0, 0),
			);
		}

		// Update description area for current selection
		const selectedItem = this.filteredItems[this.selectedIndex];
		if (selectedItem?.description) {
			this.descriptionText.setText(theme.fg("muted", `  Description: ${selectedItem.description}`));
		} else {
			this.descriptionText.setText(theme.fg("muted", "  No description available"));
		}
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		// Navigation within list
		if (kb.matches(data, "tui.select.up")) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
			this.updateList();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
			return;
		}

		// Switch kind with Tab (cycles forward)
		if (kb.matches(data, "tui.input.tab")) {
			this.currentKindIndex = (this.currentKindIndex + 1) % this.kinds.length;
			this.selectedIndex = 0;
			this.searchInput.setValue("");
			this.kindHeaderText.setText(this.getKindHeaderText());
			this.refresh();
			return;
		}

		// Switch framing: Allow-list
		if (matchesKey(data, Key.ctrl("a")) || (this.searchInput.getValue() === "" && data === "a")) {
			this.framingByKind.set(this.getCurrentKind().kind, "allow");
			this.isDirty = true;
			this.kindHeaderText.setText(this.getKindHeaderText());
			this.refresh();
			return;
		}

		// Switch framing: Block-list
		if (matchesKey(data, Key.ctrl("b")) || (this.searchInput.getValue() === "" && data === "b")) {
			this.framingByKind.set(this.getCurrentKind().kind, "block");
			this.isDirty = true;
			this.kindHeaderText.setText(this.getKindHeaderText());
			this.refresh();
			return;
		}

		// Switch scope: Scope selector
		if (matchesKey(data, Key.ctrl("o")) || (this.searchInput.getValue() === "" && data === "s")) {
			if (this.onScopeChange) {
				this.onScopeChange();
			}
			return;
		}

		// Toggle on space/enter
		if (kb.matches(data, "tui.select.confirm")) {
			const item = this.filteredItems[this.selectedIndex];
			if (item) {
				const enabledSet = this.getCurrentEnabledSet();
				if (enabledSet.has(item.id)) {
					enabledSet.delete(item.id);
				} else {
					enabledSet.add(item.id);
				}
				this.isDirty = true;
				this.refresh();
			}
			return;
		}

		// Save/persist to settings
		if (kb.matches(data, "app.models.save")) {
			this.persistChanges();
			return;
		}

		// Ctrl+C - clear search or cancel if empty
		if (matchesKey(data, Key.ctrl("c"))) {
			if (this.searchInput.getValue()) {
				this.searchInput.setValue("");
				this.refresh();
			} else {
				this.onCancel();
			}
			return;
		}

		// Escape - cancel
		if (matchesKey(data, Key.escape)) {
			this.onCancel();
			return;
		}

		// Pass everything else to search input
		this.searchInput.handleInput(data);
		this.refresh();
	}

	private persistChanges(): void {
		const resources: ResourceProfileSettings = {};
		for (const kind of this.kinds) {
			const enabledSet = this.enabledByKind.get(kind.kind)!;
			const framing = this.framingByKind.get(kind.kind)!;
			const allIds = kind.items.map((item) => item.id);
			const encoded = encodeResourceSelectionWithFraming(enabledSet, allIds, framing);
			if (encoded !== undefined) {
				resources[kind.kind] = encoded;
			}
		}
		this.onSave(resources);
		this.isDirty = false;
		this.footerText.setText(this.getFooterText());
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
