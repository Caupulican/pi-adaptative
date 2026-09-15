import { type Model, modelsAreEqual } from "@caupulican/pi-ai";
import {
	Container,
	type Focusable,
	getKeybindings,
	type Input,
	Spacer,
	Text,
	type TUI,
	visibleWidth,
} from "@caupulican/pi-tui";
import type { ModelRegistry } from "../../../core/model-registry.ts";
import type { SettingsManager } from "../../../core/settings-manager.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { formatSelectorActionHints, keyHint, keyText } from "./keybinding-hints.ts";
import {
	advanceSelectorIndex,
	filterSelectorItems,
	getCenteredVisibleRange,
	getSelectorScrollText,
	SearchableListSurface,
} from "./selector-list.ts";

interface ModelItem {
	provider: string;
	id: string;
	model: Model<any>;
}

interface ScopedModelItem {
	model: Model<any>;
	thinkingLevel?: string;
}

type ModelScope = "all" | "favorites" | "scoped";

/**
 * Component that renders a model selector with search
 */
export class ModelSelectorComponent extends Container implements Focusable {
	private searchInput: Input;
	private searchSurface: SearchableListSurface;

	// Focusable implementation - propagate to searchInput for IME cursor positioning
	get focused(): boolean {
		return this.searchSurface.focused;
	}
	set focused(value: boolean) {
		this.searchSurface.focused = value;
	}
	private listContainer: Container;
	private allModels: ModelItem[] = [];
	private scopedModelItems: ModelItem[] = [];
	private activeModels: ModelItem[] = [];
	private filteredModels: ModelItem[] = [];
	private selectedIndex: number = 0;
	private currentModel?: Model<any>;
	private modelRegistry: ModelRegistry;
	private settingsManager: SettingsManager;
	private favoriteKeys = new Set<string>();
	private onSelectCallback: (model: Model<any>) => void;
	private onSelectAsDefaultCallback?: (model: Model<any>) => void;
	private onCancelCallback: () => void;
	private errorMessage?: string;
	private tui: TUI;
	private scopedModels: ReadonlyArray<ScopedModelItem>;
	private scope: ModelScope = "all";
	private scopeText?: Text;
	private scopeHintText?: Text;

	constructor(
		tui: TUI,
		currentModel: Model<any> | undefined,
		settingsManager: SettingsManager,
		modelRegistry: ModelRegistry,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		onSelect: (model: Model<any>) => void,
		onCancel: () => void,
		initialSearchInput?: string,
		onSelectAsDefault?: (model: Model<any>) => void,
	) {
		super();

		this.tui = tui;
		this.currentModel = currentModel;
		this.settingsManager = settingsManager;
		this.modelRegistry = modelRegistry;
		this.refreshFavoriteKeys();
		this.scopedModels = scopedModels;
		this.scope = scopedModels.length > 0 ? "scoped" : "all";
		this.onSelectCallback = onSelect;
		this.onSelectAsDefaultCallback = onSelectAsDefault;
		this.onCancelCallback = onCancel;

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Add hint about model filtering
		if (scopedModels.length === 0) {
			const hintText = "Only showing models from configured providers. Use /login to add providers.";
			this.addChild(new Text(theme.fg("warning", hintText), 0, 0));
		}
		this.scopeText = new Text(this.getScopeText(), 0, 0);
		this.addChild(this.scopeText);
		this.scopeHintText = new Text(this.getScopeHintText(), 0, 0);
		this.addChild(this.scopeHintText);
		this.addChild(new Spacer(1));

		this.searchSurface = SearchableListSurface.mount(this, initialSearchInput);
		this.searchInput = this.searchSurface.searchInput;
		this.listContainer = this.searchSurface.listContainer;
		this.searchInput.onSubmit = () => {
			// Enter on search input selects the first filtered item
			if (this.filteredModels[this.selectedIndex]) {
				this.handleSelect(this.filteredModels[this.selectedIndex].model);
			}
		};

		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				`${formatSelectorActionHints(Boolean(onSelectAsDefault))}  ${keyHint("app.models.toggleFavorite", "pin/unpin")}`,
				1,
			),
		);

		// Add bottom border
		this.addChild(new DynamicBorder());

		// Load models and do initial render
		this.loadModels().then(() => {
			if (initialSearchInput) {
				this.filterModels(initialSearchInput);
			} else {
				this.updateList();
			}
			// Request re-render after models are loaded
			this.tui.requestRender();
		});
	}

	private async loadModels(): Promise<void> {
		let models: ModelItem[];

		// Refresh to pick up any changes to models.json
		this.modelRegistry.refresh();

		// Check for models.json errors
		const loadError = this.modelRegistry.getError();
		if (loadError) {
			this.errorMessage = loadError;
		}

		// Load available models (built-in models still work even if models.json failed)
		try {
			const availableModels = await this.modelRegistry.getAvailable();
			models = availableModels.map((model: Model<any>) => ({
				provider: model.provider,
				id: model.id,
				model,
			}));
		} catch (error) {
			this.allModels = [];
			this.scopedModelItems = [];
			this.activeModels = [];
			this.filteredModels = [];
			this.errorMessage = error instanceof Error ? error.message : String(error);
			return;
		}

		this.allModels = this.sortModels(models);
		this.scopedModels = this.scopedModels.map((scoped) => {
			const refreshed = this.modelRegistry.find(scoped.model.provider, scoped.model.id);
			return refreshed ? { ...scoped, model: refreshed } : scoped;
		});
		this.scopedModelItems = this.scopedModels.map((scoped) => ({
			provider: scoped.model.provider,
			id: scoped.model.id,
			model: scoped.model,
		}));
		this.activeModels = this.getActiveModels();
		this.filteredModels = this.activeModels;
		const currentIndex = this.filteredModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));
		this.selectedIndex =
			currentIndex >= 0 ? currentIndex : Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
	}

	private sortModels(models: ModelItem[]): ModelItem[] {
		const sorted = [...models];
		// Sort: favorites first, then current model, provider, and id.
		sorted.sort((a, b) => {
			const aIsCurrent = modelsAreEqual(this.currentModel, a.model);
			const bIsCurrent = modelsAreEqual(this.currentModel, b.model);
			const aIsFavorite = this.isFavorite(a);
			const bIsFavorite = this.isFavorite(b);
			if (aIsFavorite !== bIsFavorite) return aIsFavorite ? -1 : 1;
			if (aIsCurrent && !bIsCurrent) return -1;
			if (!aIsCurrent && bIsCurrent) return 1;
			return a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
		});
		return sorted;
	}

	private refreshFavoriteKeys(): void {
		this.favoriteKeys = new Set(
			this.settingsManager.getModelFavorites().map((favorite) => `${favorite.provider}\u0000${favorite.modelId}`),
		);
	}

	private modelKey(item: ModelItem): string {
		return `${item.provider}\u0000${item.id}`;
	}

	private isFavorite(item: ModelItem): boolean {
		return this.favoriteKeys.has(this.modelKey(item));
	}

	private getActiveModels(): ModelItem[] {
		if (this.scope === "scoped") return this.scopedModelItems;
		if (this.scope === "favorites") return this.allModels.filter((item) => this.isFavorite(item));
		return this.allModels;
	}

	private getScopeText(): string {
		const allText = this.scope === "all" ? theme.fg("accent", "all") : theme.fg("muted", "all");
		const favoritesText =
			this.scope === "favorites" ? theme.fg("accent", "favorites") : theme.fg("muted", "favorites");
		const scopedText = this.scope === "scoped" ? theme.fg("accent", "scoped") : theme.fg("muted", "scoped");
		return `${theme.fg("muted", "Models: ")}${allText}${theme.fg("muted", " | ")}${favoritesText}${this.scopedModels.length > 0 ? theme.fg("muted", " | ") + scopedText : ""}`;
	}

	private getScopeHintText(): string {
		return (
			keyHint("app.models.toggleFavoritesTab", "tabs") +
			theme.fg("muted", this.scopedModels.length > 0 ? " (all/favorites/scoped)" : " (all/favorites)")
		);
	}

	private setScope(scope: ModelScope): void {
		if (this.scope === scope) return;
		const previousSelection = this.filteredModels[this.selectedIndex];
		const previousKey = previousSelection ? this.modelKey(previousSelection) : undefined;
		this.scope = scope;
		this.activeModels = this.getActiveModels();
		const previousIndex = previousKey
			? this.activeModels.findIndex((item) => this.modelKey(item) === previousKey)
			: -1;
		const currentIndex = this.activeModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));
		this.selectedIndex = previousIndex >= 0 ? previousIndex : currentIndex >= 0 ? currentIndex : 0;
		this.filterModels(this.searchInput.getValue(), previousKey);
		if (this.scopeText) {
			this.scopeText.setText(this.getScopeText());
		}
	}

	private filterModels(query: string, preferredKey?: string): void {
		const matches = filterSelectorItems(
			this.activeModels,
			query,
			({ id, provider }) => `${id} ${provider} ${provider}/${id} ${provider} ${id}`,
		);
		this.filteredModels = [
			...matches.filter((item) => this.isFavorite(item)),
			...matches.filter((item) => !this.isFavorite(item)),
		];
		const preferredIndex = preferredKey
			? this.filteredModels.findIndex((item) => this.modelKey(item) === preferredKey)
			: -1;
		this.selectedIndex =
			preferredIndex >= 0
				? preferredIndex
				: Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();

		const maxVisible = 10;
		const range = getCenteredVisibleRange(this.selectedIndex, this.filteredModels.length, maxVisible);
		const { startIndex, endIndex } = range;

		// Show visible slice of filtered models
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredModels[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			const isCurrent = modelsAreEqual(this.currentModel, item.model);
			const favoriteMark = this.isFavorite(item) ? theme.fg("accent", "★ ") : " ".repeat(visibleWidth("★ "));
			const prefix = isSelected ? theme.fg("accent", "→ ") : " ".repeat(visibleWidth("→ "));
			const modelText = isSelected ? theme.fg("accent", item.id) : item.id;
			const providerBadge = theme.fg("muted", `[${item.provider}]`);
			const checkmark = isCurrent ? theme.fg("success", " ✓") : "";
			const line = `${prefix}${favoriteMark}${modelText} ${providerBadge}${checkmark}`;

			this.listContainer.addChild(new Text(line, 0, 0));
		}

		// Add scroll indicator if needed
		const scrollText = getSelectorScrollText(this.selectedIndex, this.filteredModels.length, range);
		if (scrollText) this.listContainer.addChild(new Text(theme.fg("muted", scrollText), 0, 0));

		// Show error message or "no results" if empty
		if (this.errorMessage) {
			// Show error in red
			const errorLines = this.errorMessage.split("\n");
			for (const line of errorLines) {
				this.listContainer.addChild(new Text(theme.fg("error", line), 0, 0));
			}
		} else if (this.filteredModels.length === 0) {
			const emptyText =
				this.scope === "favorites" && !this.searchInput.getValue()
					? `  No pinned models. ${keyText("app.models.toggleFavorite")} pin/unpin a model in All.`
					: "  No matching models";
			this.listContainer.addChild(new Text(theme.fg("muted", emptyText), 0, 0));
		} else {
			const selected = this.filteredModels[this.selectedIndex];
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(new Text(theme.fg("muted", `  Model Name: ${selected.model.name}`), 0, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "app.models.toggleFavoritesTab")) {
			const nextScope: ModelScope =
				this.scope === "all"
					? "favorites"
					: this.scope === "favorites"
						? this.scopedModelItems.length > 0
							? "scoped"
							: "all"
						: "all";
			this.setScope(nextScope);
			if (this.scopeHintText) this.scopeHintText.setText(this.getScopeHintText());
			return;
		}
		if (kb.matches(keyData, "app.models.toggleFavorite")) {
			const selected = this.filteredModels[this.selectedIndex];
			if (selected) {
				this.settingsManager.toggleModelFavorite(selected.provider, selected.id);
				this.refreshFavoriteKeys();
				const selectedKey = this.modelKey(selected);
				this.allModels = this.sortModels(this.allModels);
				this.activeModels = this.getActiveModels();
				this.filterModels(this.searchInput.getValue(), selectedKey);
			}
			return;
		}
		// Up arrow - wrap to bottom when at top
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = advanceSelectorIndex(this.selectedIndex, this.filteredModels.length, -1, "wrap");
			this.updateList();
		}
		// Down arrow - wrap to top when at bottom
		else if (kb.matches(keyData, "tui.select.down")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = advanceSelectorIndex(this.selectedIndex, this.filteredModels.length, 1, "wrap");
			this.updateList();
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selectedModel = this.filteredModels[this.selectedIndex];
			if (selectedModel) {
				this.handleSelect(selectedModel.model);
			}
		}
		// Ctrl+S to set as default
		else if (this.onSelectAsDefaultCallback && kb.matches(keyData, "app.models.save")) {
			const selectedModel = this.filteredModels[this.selectedIndex];
			if (selectedModel) {
				this.onSelectAsDefaultCallback(selectedModel.model);
			}
		}
		// Escape or Ctrl+C
		else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
		// Pass everything else to search input
		else {
			this.searchInput.handleInput(keyData);
			this.filterModels(this.searchInput.getValue());
		}
	}

	private handleSelect(model: Model<any>): void {
		this.onSelectCallback(model);
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
