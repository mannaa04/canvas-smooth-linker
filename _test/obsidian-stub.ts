/* 测试用的极简 obsidian 模块替身（只覆盖 harness 会碰到的部分） */

export class Component {
	addChild<T>(child: T): T {
		return child;
	}
	removeChild<T>(child: T): T {
		return child;
	}
	async load(): Promise<void> {
		/* noop */
	}
	async unload(): Promise<void> {
		/* noop */
	}
}

export class Events {
	on(): unknown {
		return {};
	}
}

export class App {
	workspace = {
		containerEl: null as unknown,
		getLeavesOfType: () => [],
		getActiveViewOfType: () => null,
		getLeaf: () => null,
	};
}

export class Notice {
	constructor(public message?: string) {
		console.log("[Notice]", message);
	}
}

export class Plugin {
	app: App;
	constructor(app: App) {
		this.app = app;
	}
	registerDomEvent(): void {
		/* noop */
	}
	registerEvent(): void {
		/* noop */
	}
	addSettingTab(): void {
		/* noop */
	}
	addCommand(): void {
		/* noop */
	}
	async loadData(): Promise<Record<string, unknown>> {
		return {};
	}
	async saveData(): Promise<void> {
		/* noop */
	}
}

export class PluginSettingTab {
	constructor(
		public app: App,
		public plugin: Plugin
	) {}
}

export class Setting {
	constructor(public containerEl: unknown) {}
}

export class ItemView {
	getViewType(): string {
		return "";
	}
}

export class TFile {
	path = "";
	extension = "";
	basename = "";
}

export class WorkspaceLeaf {}

export const MarkdownRenderer = {
	async render(_app: unknown, markdown: string, el: HTMLElement): Promise<void> {
		el.textContent = markdown;
	},
};

export class MenuItem {
	setTitle(): this {
		return this;
	}
	setIcon(): this {
		return this;
	}
	setSection(): this {
		return this;
	}
	setChecked(): this {
		return this;
	}
	onClick(): this {
		return this;
	}
}

export class Menu {
	static forEvent(): Menu {
		return new Menu();
	}
	addItem(callback: (item: MenuItem) => unknown): this {
		callback(new MenuItem());
		return this;
	}
	addSeparator(): this {
		return this;
	}
	addSections(): this {
		return this;
	}
	showAtMouseEvent(): this {
		return this;
	}
}

export function setIcon(): void {
	/* noop */
}

export function setTooltip(): void {
	/* noop */
}

export async function finishRenderMath(): Promise<void> {
	/* noop */
}

export type EventRef = unknown;
