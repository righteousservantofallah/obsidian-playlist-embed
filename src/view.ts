import { ItemView, ViewStateResult, WorkspaceLeaf } from "obsidian";
import type YtPlaylistPlugin from "./main";
import { PlaylistPlayer } from "./player";
import { parsePlaylistUrl } from "./youtube";

export const VIEW_TYPE = "youtube-playlist-view";

interface PaneState {
	url?: string;
	videoId?: string;
	time?: number;
	autoplay?: boolean;
}

/** A pane that holds one playlist player, so you can keep watching while you write notes. */
export class PlaylistView extends ItemView {
	private url = "";
	private title = "";
	private player: PlaylistPlayer | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: YtPlaylistPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.title || "YouTube playlist";
	}

	getIcon(): string {
		return "list-video";
	}

	getState(): Record<string, unknown> {
		return { url: this.url };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const s = (state ?? {}) as PaneState;
		this.url = s.url ?? "";
		this.render(s);
		await super.setState(state, result);
	}

	private render(s: PaneState): void {
		if (this.player) this.removeChild(this.player);
		this.player = null;

		const el = this.contentEl;
		el.empty();
		el.addClass("ytpl-view");

		const link = parsePlaylistUrl(this.url);
		if (!link) {
			el.createDiv({ cls: "ytpl-message", text: "This pane has no playlist. Use the command “Open YouTube playlist in a pane”." });
			return;
		}

		const host = el.createDiv({ cls: "ytpl-view-host" });
		this.player = new PlaylistPlayer(host, this.plugin, link, {
			fill: true,
			startVideoId: s.videoId,
			startTime: s.time,
			autoplay: s.autoplay,
			onLoaded: (playlist) => {
				this.title = playlist.title;
				(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
			},
		});
		this.addChild(this.player);
	}
}
