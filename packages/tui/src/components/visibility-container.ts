import { Container } from "../tui.ts";

/**
 * A Container whose children can be shown/hidden without discarding them: render() returns no
 * lines while hidden, but the wrapped children keep their own state (including their own render
 * caches), so a later show does not rebuild anything.
 */
export class VisibilityContainer extends Container {
	private visible: boolean;

	constructor(visible = true) {
		super();
		this.visible = visible;
	}

	isVisible(): boolean {
		return this.visible;
	}

	setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		this.invalidate();
	}

	override render(width: number): string[] {
		return this.visible ? super.render(width) : [];
	}
}
