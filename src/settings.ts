import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type YtPlaylistPlugin from "./main";

export interface PluginSettings {
	autoConvertPaste: boolean;
	autoplayNext: boolean;
	rememberProgress: boolean;
	listWidth: number;
	apiKey: string;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	autoConvertPaste: true,
	autoplayNext: true,
	rememberProgress: true,
	listWidth: 340,
	apiKey: "",
};

export interface SavedProgress {
	videoId: string;
	time: number;
}

export interface PluginData {
	settings: PluginSettings;
	progress: Record<string, SavedProgress>;
}

export class YtSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: YtPlaylistPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Convert pasted playlist links")
			.setDesc("When you paste a YouTube playlist link into a note, turn it into a playlist player automatically. Undo (Ctrl/Cmd+Z) brings back the plain link.")
			.addToggle((t) =>
				t.setValue(s.autoConvertPaste).onChange(async (v) => {
					s.autoConvertPaste = v;
					await this.plugin.persist();
				})
			);

		new Setting(containerEl)
			.setName("Play the next video automatically")
			.setDesc("Start the next video in the list when one finishes.")
			.addToggle((t) =>
				t.setValue(s.autoplayNext).onChange(async (v) => {
					s.autoplayNext = v;
					await this.plugin.persist();
				})
			);

		new Setting(containerEl)
			.setName("Remember where I stopped")
			.setDesc("Reopen each playlist at the last video and time you watched.")
			.addToggle((t) =>
				t.setValue(s.rememberProgress).onChange(async (v) => {
					s.rememberProgress = v;
					await this.plugin.persist();
				})
			);

		new Setting(containerEl)
			.setName("Video list width")
			.setDesc("Width of the list beside the player, in pixels. Applies to players opened from now on.")
			.addSlider((sl) =>
				sl
					.setLimits(240, 520, 10)
					.setValue(s.listWidth)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.listWidth = v;
						await this.plugin.persist();
					})
			);

		new Setting(containerEl)
			.setName("YouTube Data API key")
			.setDesc("Optional. Playlists load without it by reading the public playlist page. If that stops working or a playlist loads incompletely, a free API key from Google Cloud is the reliable alternative.")
			.addText((t) => {
				t.inputEl.type = "password";
				t.setPlaceholder("Paste key")
					.setValue(s.apiKey)
					.onChange(async (v) => {
						s.apiKey = v.trim();
						await this.plugin.persist();
					});
			});

		new Setting(containerEl)
			.setName("Clear watch history")
			.setDesc("Forget the saved position of every playlist.")
			.addButton((b) =>
				b.setButtonText("Clear").onClick(async () => {
					this.plugin.progress = {};
					await this.plugin.persist();
					new Notice("Watch history cleared.");
				})
			);
	}
}
