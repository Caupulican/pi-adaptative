/**
 * Interactive `/settings -> Worker delegation` submenu: displays effective delegation policy and live worker model
 * preview while persisting only scope-local patches (preserving sibling pins and untouched keys across scopes).
 */

import { type Component, Container, type SelectItem, type SettingItem } from "@caupulican/pi-tui";
import {
	ORCHESTRATION_THINKING_LEVELS,
	type OrchestrationModelBinding,
	type OrchestrationThinkingLevel,
} from "../../../core/orchestration/contracts.ts";
import { MAX_WORKER_DELEGATION_MAX_USD, MAX_WORKER_ROUTE_PROVIDERS } from "../../../core/settings/settings-rules.ts";
import type {
	SettingsScope,
	WorkerAccountPolicy,
	WorkerDelegationSettings,
	WorkerThinkingPolicy,
} from "../../../core/settings/settings-schema.ts";
import type { WorkerDelegationSettingsPatch } from "../../../core/settings/worker-delegation-settings.ts";
import type { ThinkingLevel } from "../../../kernel/index.ts";
import {
	AUTO_LEARN_CUSTOM_MODEL_VALUE,
	ModelSelectionSubmenu,
	SelectSubmenu,
	SettingsListSubmenu,
	screenText,
	TextInputSubmenu,
} from "./settings-submenu-primitives.ts";

const ROUTE_ACTION_AUTO = "__worker_route_auto__";
const ROUTE_ACTION_ADD_PROVIDER = "__worker_route_add_provider__";
const ROUTE_ACTION_ADD_MODEL = "__worker_route_add_model__";
const ROUTE_ENTRY_PREFIX = "__worker_route_entry__:";

export interface WorkerDelegationEditableView {
	/** Effective merged settings currently in force across scopes. */
	readonly effective: {
		readonly enabled: boolean;
		readonly maxUsd: number;
		readonly maxWallClockMs: number;
		readonly writeEnabled: boolean;
		readonly account: WorkerAccountPolicy;
		readonly thinking: WorkerThinkingPolicy;
		readonly routeProviders: readonly string[];
		readonly defaultPin?: OrchestrationModelBinding;
	};
	/** Raw layer stored on the currently selected scope (`global` or `project`). */
	readonly scopeLayer: WorkerDelegationSettings | undefined;
	/** Authoritative source of `effective.defaultPin` under `compileWorkerModelPinPolicy` precedence (`global` > `directoryProfile` > `project`). */
	readonly defaultPinSource?: SettingsScope;
	/** Whether the global layer explicitly defines `routeProviders`. */
	readonly globalHasRouteProviders: boolean;
	/** Live resolved worker model ref (`provider/modelId`) under current settings and auth. */
	readonly previewModel?: string;
	/** Bare provider id -> live latest eligible workhorse model id for inline hints. */
	readonly latestWorkhorseByProvider: Readonly<Record<string, string | undefined>>;
}

export interface WorkerDelegationSubmenuOptions {
	readState: (scope: SettingsScope) => WorkerDelegationEditableView;
	providerOptions: SelectItem[];
	modelOptions: SelectItem[];
	resolveModelThinkingLevels?: (modelPattern: string | undefined) => ThinkingLevel[] | undefined;
	onPatch: (patch: WorkerDelegationSettingsPatch, scope: SettingsScope) => void;
	onCancel: () => void;
	initialScope?: SettingsScope;
}

function formatRouteSummary(view: WorkerDelegationEditableView): string {
	const routes = view.effective.routeProviders;
	if (routes.length === 0) return screenText().workerDelegation.routing.autoValue(view.previewModel);
	if (routes.length <= 2) return routes.join(", ");
	return `${routes.slice(0, 2).join(", ")} (+${routes.length - 2})`;
}

function formatDefaultPinSummary(pin: OrchestrationModelBinding | undefined): string {
	if (!pin) return screenText().workerDelegation.defaultPin.autoValue;
	const ref = `${pin.provider}/${pin.modelId}`;
	return pin.thinkingLevel ? `${ref} (${pin.thinkingLevel})` : ref;
}

function parseProviderModelRef(raw: string): { provider: string; modelId: string } | undefined {
	const trimmed = raw.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash >= trimmed.length - 1) return undefined;
	const provider = trimmed.slice(0, slash).trim();
	const modelId = trimmed.slice(slash + 1).trim();
	return provider && modelId ? { provider, modelId } : undefined;
}

function defaultThinkingForPin(
	modelPattern: string,
	currentThinking: OrchestrationThinkingLevel | undefined,
	resolveLevels?: (modelPattern: string | undefined) => ThinkingLevel[] | undefined,
): OrchestrationThinkingLevel {
	const supported = (resolveLevels?.(modelPattern) ?? []).filter((level): level is OrchestrationThinkingLevel =>
		(ORCHESTRATION_THINKING_LEVELS as readonly string[]).includes(level),
	);
	if (currentThinking && supported.includes(currentThinking)) return currentThinking;
	if (supported.includes("medium")) return "medium";
	if (supported.length > 0) return supported[0]!;
	return "off";
}

class WorkerRouteProvidersSubmenu extends Container {
	private listMenu!: SelectSubmenu;
	private child: Component | null = null;
	private readonly scope: SettingsScope;
	private readonly options: WorkerDelegationSubmenuOptions;
	private readonly onDone: (summary: string) => void;

	constructor(scope: SettingsScope, options: WorkerDelegationSubmenuOptions, onDone: (summary: string) => void) {
		super();
		this.scope = scope;
		this.options = options;
		this.onDone = onDone;
		this.rebuild();
	}

	private activeRoutes(view: WorkerDelegationEditableView): string[] {
		return [...(view.scopeLayer?.routeProviders ?? view.effective.routeProviders)];
	}

	private saveRoutes(next: string[]): void {
		const view = this.options.readState(this.scope);
		const deduped = Array.from(new Set(next.map((entry) => entry.trim()).filter(Boolean))).slice(
			0,
			MAX_WORKER_ROUTE_PROVIDERS,
		);
		if (deduped.length === 0) {
			// On project scope with global routes present, an empty array overrides global to Automatic; otherwise clear.
			const cleared = this.scope === "project" && view.globalHasRouteProviders ? [] : undefined;
			this.options.onPatch({ routeProviders: cleared }, this.scope);
		} else {
			this.options.onPatch({ routeProviders: deduped }, this.scope);
		}
	}

	private rebuild(): void {
		this.clear();
		const text = screenText().workerDelegation.routing;
		const view = this.options.readState(this.scope);
		const routes = view.effective.routeProviders;

		const items: SelectItem[] = [
			{
				value: ROUTE_ACTION_AUTO,
				label: text.useAutomatic,
				description: text.useAutomaticDescription,
			},
			{
				value: ROUTE_ACTION_ADD_PROVIDER,
				label: text.addProvider,
				description: text.addProviderDescription,
			},
			{
				value: ROUTE_ACTION_ADD_MODEL,
				label: text.addModel,
				description: text.addModelDescription,
			},
			...routes.map((entry, index) => {
				const isProvider = !entry.includes("/");
				const latest = isProvider ? view.latestWorkhorseByProvider[entry] : undefined;
				return {
					value: `${ROUTE_ENTRY_PREFIX}${index}`,
					label: `${index + 1}. ${entry}`,
					description: isProvider ? text.entryProviderDescription(latest) : text.entryModelDescription,
				};
			}),
		];

		this.listMenu = new SelectSubmenu(
			text.title,
			text.subtitle(view.previewModel),
			items,
			items[0]?.value ?? ROUTE_ACTION_AUTO,
			(value) => this.handleSelect(value),
			() => this.onDone(formatRouteSummary(this.options.readState(this.scope))),
		);
		this.addChild(this.listMenu);
	}

	private handleSelect(value: string): void {
		const text = screenText().workerDelegation.routing;
		if (value === ROUTE_ACTION_AUTO) {
			this.saveRoutes([]);
			this.rebuild();
			return;
		}
		if (value === ROUTE_ACTION_ADD_PROVIDER) {
			this.child = new SelectSubmenu(
				text.addProviderTitle,
				text.addProviderSubtitle,
				this.options.providerOptions,
				"",
				(provider) => {
					const view = this.options.readState(this.scope);
					const next = this.activeRoutes(view);
					if (provider && !next.includes(provider)) next.push(provider);
					this.saveRoutes(next);
					this.child = null;
					this.rebuild();
				},
				() => {
					this.child = null;
				},
			);
			return;
		}
		if (value === ROUTE_ACTION_ADD_MODEL) {
			const picker = screenText().modelPicker.workerModel;
			const options: SelectItem[] = [
				...this.options.modelOptions,
				{
					value: AUTO_LEARN_CUSTOM_MODEL_VALUE,
					label: screenText().modelPicker.manualOption,
					description: picker.customDescription,
				},
			];
			this.child = new ModelSelectionSubmenu(
				options,
				"",
				(selected) => {
					const trimmed = selected.trim();
					if (trimmed) {
						const view = this.options.readState(this.scope);
						const next = this.activeRoutes(view);
						if (!next.includes(trimmed)) next.push(trimmed);
						this.saveRoutes(next);
					}
					this.child = null;
					this.rebuild();
				},
				() => {
					this.child = null;
				},
				{
					title: picker.title,
					description: picker.description,
					customTitle: picker.customTitle,
					customDescription: picker.customDescription,
					customEmptyHint: picker.customEmptyHint,
					customEmptyValue: "",
				},
			);
			return;
		}
		if (value.startsWith(ROUTE_ENTRY_PREFIX)) {
			const index = Number.parseInt(value.slice(ROUTE_ENTRY_PREFIX.length), 10);
			const view = this.options.readState(this.scope);
			const routes = this.activeRoutes(view);
			const entry = routes[index];
			if (!entry) return;
			const actions: SelectItem[] = [
				...(index > 0
					? [
							{ value: "top", label: text.moveToTop },
							{ value: "up", label: text.moveUp },
						]
					: []),
				{ value: "remove", label: text.removeEntry },
			];
			this.child = new SelectSubmenu(
				text.entryActionsTitle(entry),
				text.entryActionsDescription,
				actions,
				actions[0]?.value ?? "remove",
				(action) => {
					const updated = [...routes];
					if (action === "top" && index > 0) {
						updated.unshift(...updated.splice(index, 1));
					} else if (action === "up" && index > 0) {
						[updated[index - 1], updated[index]] = [updated[index]!, updated[index - 1]!];
					} else if (action === "remove") {
						updated.splice(index, 1);
					}
					this.saveRoutes(updated);
					this.child = null;
					this.rebuild();
				},
				() => {
					this.child = null;
				},
			);
		}
	}

	handleInput(data: string): void {
		if (this.child) {
			this.child.handleInput?.(data);
			return;
		}
		this.listMenu.handleInput(data);
	}

	render(width: number): string[] {
		return this.child ? this.child.render(width) : super.render(width);
	}

	invalidate(): void {
		super.invalidate();
		this.child?.invalidate?.();
	}
}

export class WorkerDelegationSettingsSubmenu extends SettingsListSubmenu {
	private scope: SettingsScope;
	private readonly options: WorkerDelegationSubmenuOptions;
	private readonly items: SettingItem[];

	constructor(options: WorkerDelegationSubmenuOptions) {
		super();
		this.options = options;
		this.scope = options.initialScope ?? "global";
		const initial = this.options.readState(this.scope);
		const text = screenText().workerDelegation;

		this.items = [
			{
				id: "worker-delegation-scope",
				label: text.scope.label,
				description: text.scope.description,
				currentValue: this.scope,
				values: ["global", "project"],
				valueLabels: screenText().valueLabels.scope,
			},
			{
				id: "worker-delegation-enabled",
				label: text.enabled.label,
				description: text.enabled.description,
				currentValue: String(initial.effective.enabled),
				values: ["true", "false"],
				valueLabels: screenText().valueLabels.onOff,
			},
			{
				id: "worker-delegation-account",
				label: text.account.label,
				description: text.account.description,
				currentValue: initial.effective.account,
				values: ["other", "same"],
				valueLabels: screenText().valueLabels.workerAccount,
			},
			{
				id: "worker-delegation-thinking",
				label: text.thinking.label,
				description: text.thinking.description,
				currentValue: initial.effective.thinking,
				values: ["step_down", "inherit"],
				valueLabels: screenText().valueLabels.workerThinking,
			},
			{
				id: "worker-delegation-routing",
				label: text.routing.label,
				description: this.routingDescription(initial),
				currentValue: formatRouteSummary(initial),
				submenu: (_currentValue, done) =>
					new WorkerRouteProvidersSubmenu(this.scope, this.options, (summary) => {
						this.refreshRows();
						done(summary);
					}),
			},
			{
				id: "worker-delegation-default-pin",
				label: text.defaultPin.label,
				description: this.defaultPinDescription(initial),
				currentValue: formatDefaultPinSummary(initial.effective.defaultPin),
				submenu: (_currentValue, done) => {
					const current = this.options.readState(this.scope);
					const picker = screenText().modelPicker.workerPin;
					const currentRef = current.effective.defaultPin
						? `${current.effective.defaultPin.provider}/${current.effective.defaultPin.modelId}`
						: "";
					const pinOptions: SelectItem[] = [
						{
							value: "",
							label: text.defaultPin.autoOption,
							description: text.defaultPin.autoOptionDescription,
						},
						...this.options.modelOptions,
						{
							value: AUTO_LEARN_CUSTOM_MODEL_VALUE,
							label: screenText().modelPicker.manualOption,
							description: picker.customDescription,
						},
					];
					return new ModelSelectionSubmenu(
						pinOptions,
						currentRef,
						(value) => {
							const trimmed = value.trim();
							if (!trimmed) {
								this.options.onPatch({ defaultModelPin: undefined }, this.scope);
							} else {
								const parsed = parseProviderModelRef(trimmed);
								if (parsed) {
									const thinkingLevel = defaultThinkingForPin(
										`${parsed.provider}/${parsed.modelId}`,
										current.effective.defaultPin?.thinkingLevel,
										this.options.resolveModelThinkingLevels,
									);
									this.options.onPatch(
										{
											defaultModelPin: { provider: parsed.provider, modelId: parsed.modelId, thinkingLevel },
										},
										this.scope,
									);
								}
							}
							const refreshed = this.refreshRows();
							done(formatDefaultPinSummary(refreshed.effective.defaultPin));
						},
						() => done(),
						{
							title: picker.title,
							description: picker.description,
							customTitle: picker.customTitle,
							customDescription: picker.customDescription,
							customEmptyHint: picker.customEmptyHint,
							customEmptyValue: "",
						},
					);
				},
			},
			{
				id: "worker-delegation-default-pin-thinking",
				label: text.defaultPinThinking.label,
				description: text.defaultPinThinking.description,
				currentValue: initial.effective.defaultPin?.thinkingLevel ?? text.defaultPin.autoValue,
				submenu: (_currentValue, done) => {
					const current = this.options.readState(this.scope);
					const pin = current.effective.defaultPin;
					if (!pin) {
						return new SelectSubmenu(
							text.defaultPinThinking.title,
							text.defaultPinThinking.descriptionSubmenu,
							[{ value: "", label: text.defaultPin.autoValue }],
							"",
							() => done(),
							() => done(),
						);
					}
					const ref = `${pin.provider}/${pin.modelId}`;
					const levels = (
						this.options.resolveModelThinkingLevels?.(ref) ?? [...ORCHESTRATION_THINKING_LEVELS]
					).filter((level): level is OrchestrationThinkingLevel =>
						(ORCHESTRATION_THINKING_LEVELS as readonly string[]).includes(level),
					);
					return new SelectSubmenu(
						text.defaultPinThinking.title,
						text.defaultPinThinking.descriptionSubmenu,
						levels.map((level) => ({ value: level, label: level })),
						pin.thinkingLevel ?? levels[0] ?? "off",
						(selected) => {
							if (selected) {
								this.options.onPatch(
									{
										defaultModelPin: {
											provider: pin.provider,
											modelId: pin.modelId,
											thinkingLevel: selected as OrchestrationThinkingLevel,
										},
									},
									this.scope,
								);
							}
							const refreshed = this.refreshRows();
							done(refreshed.effective.defaultPin?.thinkingLevel ?? text.defaultPin.autoValue);
						},
						() => done(),
					);
				},
			},
			{
				id: "worker-delegation-max-usd",
				label: text.budget.label,
				description: text.budget.description,
				currentValue: String(initial.effective.maxUsd),
				submenu: (_currentValue, done) => {
					const current = this.options.readState(this.scope);
					return new TextInputSubmenu(
						text.budgetTitle,
						text.budgetDescription(MAX_WORKER_DELEGATION_MAX_USD),
						String(current.effective.maxUsd),
						(value) => {
							const maxUsd = Number(value.trim());
							if (Number.isFinite(maxUsd) && maxUsd >= 0 && maxUsd <= MAX_WORKER_DELEGATION_MAX_USD) {
								this.options.onPatch({ maxUsd }, this.scope);
								this.refreshRows();
								done(String(maxUsd));
								return;
							}
							done();
						},
						() => done(),
						text.budgetHint(MAX_WORKER_DELEGATION_MAX_USD),
					);
				},
			},
			{
				id: "worker-delegation-max-wall-clock-ms",
				label: text.milliseconds.label,
				description: text.milliseconds.description,
				currentValue: String(initial.effective.maxWallClockMs),
				submenu: (_currentValue, done) => {
					const current = this.options.readState(this.scope);
					return new TextInputSubmenu(
						text.millisecondsTitle,
						text.millisecondsDescription,
						String(current.effective.maxWallClockMs),
						(value) => {
							const maxWallClockMs = Number(value.trim());
							if (Number.isSafeInteger(maxWallClockMs) && maxWallClockMs >= 0) {
								this.options.onPatch({ maxWallClockMs }, this.scope);
								this.refreshRows();
								done(String(maxWallClockMs));
								return;
							}
							done();
						},
						() => done(),
						text.millisecondsHint,
					);
				},
			},
			{
				id: "worker-delegation-write-enabled",
				label: text.writeEnabled.label,
				description: text.writeEnabled.description,
				currentValue: String(initial.effective.writeEnabled),
				values: ["true", "false"],
				valueLabels: screenText().valueLabels.onOff,
			},
		];

		this.mountSettingsList(
			this.items,
			(id, newValue) => {
				switch (id) {
					case "worker-delegation-scope":
						// Switching save scope only updates which scope receives future edits; it writes nothing.
						this.scope = newValue as SettingsScope;
						this.refreshRows();
						return;
					case "worker-delegation-enabled":
						this.options.onPatch({ enabled: newValue === "true" }, this.scope);
						break;
					case "worker-delegation-account":
						this.options.onPatch({ account: newValue as WorkerAccountPolicy }, this.scope);
						break;
					case "worker-delegation-thinking":
						this.options.onPatch({ thinking: newValue as WorkerThinkingPolicy }, this.scope);
						break;
					case "worker-delegation-write-enabled":
						this.options.onPatch({ writeEnabled: newValue === "true" }, this.scope);
						break;
					default:
						return;
				}
				this.refreshRows();
			},
			this.options.onCancel,
		);
	}

	private routingDescription(view: WorkerDelegationEditableView): string {
		const inherited =
			this.scope === "project" && view.scopeLayer?.routeProviders === undefined && view.globalHasRouteProviders;
		return screenText().workerDelegation.routing.description(view.previewModel, inherited);
	}

	private defaultPinDescription(view: WorkerDelegationEditableView): string {
		const shadowedByGlobal = this.scope === "project" && view.defaultPinSource === "global";
		return screenText().workerDelegation.defaultPin.description(shadowedByGlobal);
	}

	private refreshRows(): WorkerDelegationEditableView {
		const view = this.options.readState(this.scope);
		const byId = new Map(this.items.map((item) => [item.id, item]));
		const set = (id: string, value: string, description?: string) => {
			const item = byId.get(id);
			if (!item) return;
			item.currentValue = value;
			if (description !== undefined) item.description = description;
		};
		set("worker-delegation-scope", this.scope);
		set("worker-delegation-enabled", String(view.effective.enabled));
		set("worker-delegation-account", view.effective.account);
		set("worker-delegation-thinking", view.effective.thinking);
		set("worker-delegation-routing", formatRouteSummary(view), this.routingDescription(view));
		set(
			"worker-delegation-default-pin",
			formatDefaultPinSummary(view.effective.defaultPin),
			this.defaultPinDescription(view),
		);
		set(
			"worker-delegation-default-pin-thinking",
			view.effective.defaultPin?.thinkingLevel ?? screenText().workerDelegation.defaultPin.autoValue,
		);
		set("worker-delegation-max-usd", String(view.effective.maxUsd));
		set("worker-delegation-max-wall-clock-ms", String(view.effective.maxWallClockMs));
		set("worker-delegation-write-enabled", String(view.effective.writeEnabled));
		return view;
	}
}
