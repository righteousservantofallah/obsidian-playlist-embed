import { App, Editor, Modal, Plugin, Setting } from "obsidian";
import { PlaylistPlayer, PopOutState } from "./player";
import { DEFAULT_SETTINGS, PluginData, PluginSettings, SavedProgress, YtSettingTab } from "./settings";
import { PlaylistView, VIEW_TYPE } from "./view";
import { ParsedLink, parsePlaylistUrl } from "./youtube";

const BLOCK_LANG = "youtube-playlist";

export default class YtPlaylistPlugin extends Plugin {
	settings: PluginSettings = { ...DEFAULT_SETTINGS };
	progress: Record<string, SavedProgress> = {};
	private saveTimer: number | null = null;

	async onload(): Promise<void> {
		const data = (await this.loadData()) as Partial<PluginData> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings);
		this.progress = data?.progress ?? {};

		this.addSettingTab(new YtSettingTab(this.app, this));
		this.registerView(VIEW_TYPE, (leaf) => new PlaylistView(leaf, this));

		// ```youtube-playlist
		// https://www.youtube.com/playlist?list=...
		// ```
		this.registerMarkdownCodeBlockProcessor(BLOCK_LANG, (source, el, ctx) => {
			const url = source.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
			const link = parsePlaylistUrl(url);
			if (!link) {
				el.createDiv({
					cls: "ytpl-message is-error",
					text: "Put a YouTube playlist link inside this block. It needs list=… in the address.",
				});
				return;
			}
			ctx.addChild(
				new PlaylistPlayer(el, this, link, {
					onPopOut: (state) => void this.openInPane(url, state),
				})
			);
		});

		// Pasting a playlist link turns it into a player block.
		this.registerEvent(
			this.app.workspace.on("editor-paste", (evt: ClipboardEvent, editor: Editor) => {
				if (!this.settings.autoConvertPaste || evt.defaultPrevented) return;
				if (editor.somethingSelected() || this.insideCodeFence(editor)) return;

				const text = evt.clipboardData?.getData("text/plain")?.trim() ?? "";
				if (!text || /\s/.test(text) || !parsePlaylistUrl(text)) return;

				evt.preventDefault();
				const cursor = editor.getCursor();
				const before = editor.getLine(cursor.line).slice(0, cursor.ch).trim();
				editor.replaceSelection(`${before ? "\n" : ""}\`\`\`${BLOCK_LANG}\n${text}\n\`\`\`\n`);
			})
		);

		this.addCommand({
			id: "insert-playlist",
			name: "Insert YouTube playlist",
			editorCallback: (editor) => {
				new UrlModal(this.app, "Insert YouTube playlist", (url) => {
					editor.replaceSelection(`\`\`\`${BLOCK_LANG}\n${url}\n\`\`\`\n`);
				}).open();
			},
		});

		this.addCommand({
			id: "open-playlist-pane",
			name: "Open YouTube playlist in a pane",
			callback: () => {
				new UrlModal(this.app, "Open YouTube playlist", (url) => void this.openInPane(url)).open();
			},
		});
	}

	onunload(): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		void this.persist();
	}

	// ---- panes ------------------------------------------------------------

	async openInPane(url: string, state?: PopOutState): Promise<void> {
		const { workspace } = this.app;
		const leaf = workspace.getLeavesOfType(VIEW_TYPE)[0] ?? workspace.getLeaf("split", "vertical");
		await leaf.setViewState({
			type: VIEW_TYPE,
			active: true,
			state: { url, videoId: state?.videoId, time: state?.time, autoplay: state?.playing },
		});
		await workspace.revealLeaf(leaf);
	}

	// ---- saved progress -----------------------------------------------------

	getProgress(playlistId: string): SavedProgress | undefined {
		return this.progress[playlistId];
	}

	setProgress(playlistId: string, value: SavedProgress): void {
		if (!this.settings.rememberProgress) return;
		this.progress[playlistId] = { videoId: value.videoId, time: Math.floor(value.time) };
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => void this.persist(), 3000);
	}

	persist(): Promise<void> {
		return this.saveData({ settings: this.settings, progress: this.progress } satisfies PluginData);
	}

	// ---- helpers ------------------------------------------------------------

	private insideCodeFence(editor: Editor): boolean {
		const { line } = editor.getCursor();
		let open = false;
		for (let i = 0; i < line; i++) {
			if (/^\s*(```|~~~)/.test(editor.getLine(i))) open = !open;
		}
		return open;
	}
}

class UrlModal extends Modal {
	constructor(app: App, private heading: string, private onSubmit: (url: string, link: ParsedLink) => void) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.heading);
		const input = this.contentEl.createEl("input", {
			type: "text",
			cls: "ytpl-modal-input",
			placeholder: "https://www.youtube.com/playlist?list=…",
		});
		const error = this.contentEl.createDiv({ cls: "ytpl-modal-error" });

		const submit = () => {
			const url = input.value.trim();
			const link = parsePlaylistUrl(url);
			if (!link) {
				error.setText("That isn't a YouTube playlist link. The address needs list=… in it.");
				return;
			}
			this.close();
			this.onSubmit(url, link);
		};
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") submit();
		});
		new Setting(this.contentEl).addButton((b) => b.setButtonText("Continue").setCta().onClick(submit));
		input.focus();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
