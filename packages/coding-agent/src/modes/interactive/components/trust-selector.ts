import { Container, getKeybindings, Spacer, Text } from "@caupulican/pi-tui";
import { interfaceText } from "../../../core/language/interface-text.ts";
import type { ProjectTrustDecision } from "../../../core/trust-manager.ts";
import { theme } from "../../../presentation/theme-model.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { advanceSelectorIndex, SelectorNavigationFooter } from "./selector-list.ts";

export interface TrustSelectorOptions {
	cwd: string;
	savedDecision: ProjectTrustDecision;
	projectTrusted: boolean;
	onSelect: (trusted: boolean) => void;
	onCancel: () => void;
}

/** The two answers, in the order they are drawn; the decision itself is the boolean the code saves. */
const TRUST_ANSWERS: readonly boolean[] = [true, false];

function formatDecision(decision: ProjectTrustDecision): string {
	const text = interfaceText().selectors.trust;
	if (decision === true) {
		return text.trusted;
	}
	if (decision === false) {
		return text.untrusted;
	}
	return text.none;
}

export class TrustSelectorComponent extends Container {
	private selectedIndex: number;
	private readonly listContainer: Container;
	private readonly savedDecision: ProjectTrustDecision;
	private readonly onSelectCallback: (trusted: boolean) => void;
	private readonly onCancelCallback: () => void;

	constructor(options: TrustSelectorOptions) {
		super();

		this.savedDecision = options.savedDecision;
		// A saved "no" lands on the second answer; no saved decision at all lands on the first.
		this.selectedIndex = options.savedDecision === false ? 1 : 0;
		this.onSelectCallback = options.onSelect;
		this.onCancelCallback = options.onCancel;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		const text = interfaceText().selectors;
		this.addChild(new Text(theme.fg("accent", theme.bold(text.trust.title)), 1, 0));
		this.addChild(new Text(theme.fg("muted", options.cwd), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", text.trust.savedDecision(formatDecision(options.savedDecision))), 1, 0));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					text.trust.currentSession(options.projectTrusted ? text.trust.trusted : text.trust.untrusted),
				),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new SelectorNavigationFooter(text.shared.save));

		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();
		const text = interfaceText().selectors.trust;
		for (let i = 0; i < TRUST_ANSWERS.length; i++) {
			const trusted = TRUST_ANSWERS[i];
			if (trusted === undefined) {
				continue;
			}

			const isSelected = i === this.selectedIndex;
			const isCurrent = trusted === this.savedDecision;
			const checkmark = isCurrent ? theme.fg("success", " ✓") : "";
			const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
			const wording = trusted ? text.trust : text.distrust;
			const label = isSelected ? theme.fg("accent", wording) : theme.fg("text", wording);
			this.listContainer.addChild(new Text(`${prefix}${label}${checkmark}`, 1, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = advanceSelectorIndex(this.selectedIndex, TRUST_ANSWERS.length, -1, "clamp");
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = advanceSelectorIndex(this.selectedIndex, TRUST_ANSWERS.length, 1, "clamp");
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const selected = TRUST_ANSWERS[this.selectedIndex];
			if (selected !== undefined) {
				this.onSelectCallback(selected);
			}
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
	}
}
