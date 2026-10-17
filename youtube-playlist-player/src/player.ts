import { MarkdownRenderChild, Notice, setIcon } from "obsidian";
import type YtPlaylistPlugin from "./main";
import { formatDuration, loadPlaylist, ParsedLink, Playlist, PlaylistLoadError } from "./youtube";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface PopOutState {
	videoId: string;
	time: number;
	playing: boolean;
}

export interface PlayerOptions {
	/** Fill the height of the container (used in the pane view). */
	fill?: boolean;
	startVideoId?: string;
	startTime?: number;
	autoplay?: boolean;
	/** When set, a "pop out" button appears that hands playback to the callback. */
	onPopOut?: (state: PopOutState) => void;
	onLoaded?: (playlist: Playlist) => void;
}

// ---------------------------------------------------------------------------
// YouTube IFrame API loader (one per window, so pop-out windows work too)
// ---------------------------------------------------------------------------

const apiByWindow = new WeakMap<Window, Promise<any>>();

function loadYouTubeApi(win: Window): Promise<any> {
	const existing = apiByWindow.get(win);
	if (existing) return existing;

	const promise = new Promise<any>((resolve, reject) => {
		const w = win as any;
		if (w.YT?.Player) {
			resolve(w.YT);
			return;
		}
		const previous = w.onYouTubeIframeAPIReady;
		w.onYouTubeIframeAPIReady = () => {
			if (typeof previous === "function") previous();
			resolve(w.YT);
		};
		const script = win.document.createElement("script");
		script.src = "https://www.youtube.com/iframe_api";
		script.onerror = () => reject(new Error("Could not load the YouTube player API."));
		win.document.head.appendChild(script);
		win.setTimeout(() => reject(new Error("The YouTube player API took too long to load.")), 12000);
	});
	promise.catch(() => apiByWindow.delete(win));
	apiByWindow.set(win, promise);
	return promise;
}

function embedUrl(videoId: string, start = 0, autoplay = false): string {
	const p = new URLSearchParams({ enablejsapi: "1", rel: "0", playsinline: "1" });
	if (start > 0) p.set("start", String(Math.floor(start)));
	if (autoplay) p.set("autoplay", "1");
	// youtube-nocookie + a referrer policy avoid "Error 153" inside Obsidian.
	return `https://www.youtube-nocookie.com/embed/${videoId}?${p.toString()}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export class PlaylistPlayer extends MarkdownRenderChild {
	private root!: HTMLElement;
	private layout!: HTMLElement;
	private screen!: HTMLElement;
	private titleEl!: HTMLElement;
	private channelEl!: HTMLElement;
	private hintEl!: HTMLElement;
	private counterEl!: HTMLElement;
	private listEl!: HTMLElement;
	private emptyEl!: HTMLElement;
	private autoplayChip!: HTMLElement;
	private shuffleChip!: HTMLElement;

	private playlist!: Playlist;
	private items: HTMLElement[] = [];
	private showChannels = false;

	private index = -1;
	private yt: any = null;
	private ready = false;
	private pending: { index: number; time: number } | null = null;
	private iframe: HTMLIFrameElement | null = null;
	private ticker: number | null = null;
	private playing = false;
	private autoplay: boolean;
	private shuffle = false;
	private gone = false;
	private resumeTime = 0;

	constructor(
		containerEl: HTMLElement,
		private plugin: YtPlaylistPlugin,
		private link: ParsedLink,
		private opts: PlayerOptions = {}
	) {
		super(containerEl);
		this.autoplay = plugin.settings.autoplayNext;
	}

	onload(): void {
		this.root = this.containerEl.createDiv({ cls: "ytpl-root" });
		if (this.opts.fill) this.root.addClass("is-fill");
		this.root.style.setProperty("--ytpl-list-width", `${this.plugin.settings.listWidth}px`);

		// Stack the list under the video when there isn't room beside it.
		const observer = new ResizeObserver(() => {
			const w = this.root.clientWidth;
			if (w > 0 && this.layout) this.layout.toggleClass("is-stacked", w < 640);
		});
		observer.observe(this.root);
		this.register(() => observer.disconnect());

		void this.start();
	}

	onunload(): void {
		this.gone = true;
		this.saveProgress();
		this.destroyPlayer();
		this.root?.remove();
	}

	// ---- loading ----------------------------------------------------------

	private async start(): Promise<void> {
		this.root.empty();
		this.root.createDiv({ cls: "ytpl-message", text: "Loading playlist…" });

		try {
			this.playlist = await loadPlaylist(this.link.playlistId, this.plugin.settings.apiKey);
		} catch (e) {
			if (!this.gone) this.renderError(e);
			return;
		}
		if (this.gone) return;

		const start = this.pickStart();
		if (!start) {
			this.renderError(new Error("Every video in this playlist is private or deleted."));
			return;
		}
		this.opts.onLoaded?.(this.playlist);
		this.buildLayout();
		await this.mount(start.index, start.time, this.opts.autoplay === true);
	}

	private pickStart(): { index: number; time: number } | null {
		const vids = this.playlist.videos;
		const find = (id?: string) => (id ? vids.findIndex((v) => v.id === id && !v.unavailable) : -1);

		let index = find(this.opts.startVideoId);
		let time = index >= 0 ? this.opts.startTime ?? 0 : 0;

		if (index < 0) index = find(this.link.startVideoId);
		if (index < 0 && this.plugin.settings.rememberProgress) {
			const saved = this.plugin.getProgress(this.playlist.id);
			if (saved) {
				index = find(saved.videoId);
				time = index >= 0 ? saved.time : 0;
			}
		}
		if (index < 0) {
			index = vids.findIndex((v) => !v.unavailable);
			time = 0;
		}
		return index < 0 ? null : { index, time };
	}

	private renderError(e: unknown): void {
		this.root.empty();
		const box = this.root.createDiv({ cls: "ytpl-message is-error" });
		box.createEl("strong", { text: "Couldn't load this playlist" });
		box.createDiv({ text: e instanceof Error ? e.message : String(e) });
		box.createDiv({
			cls: "ytpl-message-hint",
			text: "Private playlists and auto-generated mixes (list=RD…) can't be read. For a public playlist, try again, or add a YouTube Data API key in the plugin settings.",
		});
		const row = box.createDiv({ cls: "ytpl-message-actions" });
		row.createEl("button", { text: "Try again" }).addEventListener("click", () => void this.start());
		if (e instanceof PlaylistLoadError) {
			row.createEl("button", { text: "Copy debug info" }).addEventListener("click", () => {
				void navigator.clipboard.writeText(e.details).then(() => new Notice("Debug info copied."));
			});
		}
	}

	// ---- layout -----------------------------------------------------------

	private buildLayout(): void {
		this.root.empty();
		this.layout = this.root.createDiv({ cls: "ytpl" });
		this.layout.toggleClass("is-stacked", this.root.clientWidth > 0 && this.root.clientWidth < 640);

		const channels = new Set(this.playlist.videos.map((v) => v.channel).filter(Boolean));
		this.showChannels = channels.size > 1;

		// Left: player + now playing
		const stage = this.layout.createDiv({ cls: "ytpl-stage" });
		this.screen = stage.createDiv({ cls: "ytpl-screen" });

		const now = stage.createDiv({ cls: "ytpl-now" });
		this.titleEl = now.createDiv({ cls: "ytpl-now-title" });
		this.channelEl = now.createDiv({ cls: "ytpl-now-channel" });
		this.hintEl = now.createDiv({ cls: "ytpl-hint" });

		const controls = stage.createDiv({ cls: "ytpl-controls" });
		this.iconButton(controls, "skip-back", "Previous video", () => this.step(-1, true));
		this.iconButton(controls, "skip-forward", "Next video", () => this.step(1, true));
		this.autoplayChip = this.chip(controls, "Autoplay", "Play the next video when one ends", this.autoplay, () => {
			this.autoplay = !this.autoplay;
			this.autoplayChip.toggleClass("is-active", this.autoplay);
			this.plugin.settings.autoplayNext = this.autoplay;
			void this.plugin.persist();
		});
		this.shuffleChip = this.chip(controls, "Shuffle", "Pick a random video next", this.shuffle, () => {
			this.shuffle = !this.shuffle;
			this.shuffleChip.toggleClass("is-active", this.shuffle);
		});
		controls.createDiv({ cls: "ytpl-spacer" });
		if (this.opts.onPopOut) {
			this.iconButton(controls, "panel-right-open", "Open in a pane beside the note", () => this.popOut());
		}
		this.iconButton(controls, "external-link", "Open this video on YouTube", () => {
			const v = this.playlist.videos[this.index];
			if (!v) return;
			const url = `https://www.youtube.com/watch?v=${v.id}&list=${this.playlist.id}`;
			this.containerEl.win.open(url, "_blank");
		});

		// Right: list
		const side = this.layout.createDiv({ cls: "ytpl-side" });
		const inner = side.createDiv({ cls: "ytpl-side-inner" });
		const head = inner.createDiv({ cls: "ytpl-side-head" });

		const top = head.createDiv({ cls: "ytpl-side-top" });
		const heading = top.createDiv({ cls: "ytpl-side-heading" });
		heading.createDiv({ cls: "ytpl-side-title", text: this.playlist.title });
		this.counterEl = heading.createDiv({ cls: "ytpl-side-count" });
		if (this.playlist.note) heading.createDiv({ cls: "ytpl-side-note", text: this.playlist.note });
		this.iconButton(top, "refresh-cw", "Reload playlist", () => void this.refresh());

		const search = head.createEl("input", {
			cls: "ytpl-search",
			type: "search",
			placeholder: "Filter videos",
			attr: { "aria-label": "Filter videos" },
		});
		search.addEventListener("input", () => this.applyFilter(search.value));

		this.listEl = inner.createDiv({ cls: "ytpl-list" });
		this.emptyEl = inner.createDiv({ cls: "ytpl-empty is-hidden", text: "No videos match." });
		this.renderList();
	}

	private iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLElement {
		const btn = parent.createEl("button", {
			cls: "clickable-icon ytpl-icon-btn",
			attr: { type: "button", "aria-label": label },
		});
		setIcon(btn, icon);
		btn.addEventListener("click", onClick);
		return btn;
	}

	private chip(parent: HTMLElement, text: string, label: string, active: boolean, onClick: () => void): HTMLElement {
		const btn = parent.createEl("button", {
			cls: "ytpl-chip",
			text,
			attr: { type: "button", "aria-label": label },
		});
		btn.toggleClass("is-active", active);
		btn.addEventListener("click", onClick);
		return btn;
	}

	private renderList(): void {
		this.listEl.empty();
		this.items = [];
		const vids = this.playlist.videos;
		this.counterEl.setText(`${vids.length} ${vids.length === 1 ? "video" : "videos"}`);

		vids.forEach((v, i) => {
			const item = this.listEl.createEl("button", { cls: "ytpl-item", attr: { type: "button" } });
			item.createDiv({ cls: "ytpl-index", text: String(i + 1) });

			const thumb = item.createDiv({ cls: "ytpl-thumb" });
			thumb.createEl("img", { attr: { src: v.thumb, loading: "lazy", alt: "" } });
			if (v.duration > 0) thumb.createDiv({ cls: "ytpl-dur", text: formatDuration(v.duration) });

			const meta = item.createDiv({ cls: "ytpl-meta" });
			meta.createDiv({ cls: "ytpl-title", text: v.title });
			if (this.showChannels && v.channel) meta.createDiv({ cls: "ytpl-channel", text: v.channel });

			if (v.unavailable) {
				item.addClass("is-unavailable");
				item.disabled = true;
			}
			item.addEventListener("click", () => this.playIndex(i));
			this.items.push(item);
		});
	}

	private applyFilter(query: string): void {
		const q = query.trim().toLowerCase();
		let visible = 0;
		this.playlist.videos.forEach((v, i) => {
			const hit = !q || v.title.toLowerCase().includes(q) || v.channel.toLowerCase().includes(q);
			this.items[i]?.toggleClass("is-hidden", !hit);
			if (hit) visible++;
		});
		this.emptyEl.toggleClass("is-hidden", visible > 0);
	}

	private paintCurrent(previous: number): void {
		const setCell = (i: number, current: boolean) => {
			const item = this.items[i];
			if (!item) return;
			item.toggleClass("is-current", current);
			const cell = item.querySelector<HTMLElement>(".ytpl-index");
			if (!cell) return;
			if (current) setIcon(cell, "play");
			else {
				cell.empty();
				cell.setText(String(i + 1));
			}
		};
		if (previous >= 0 && previous !== this.index) setCell(previous, false);
		if (this.index >= 0) setCell(this.index, true);

		const v = this.playlist.videos[this.index];
		this.titleEl.setText(v ? v.title : "");
		this.channelEl.setText(v ? v.channel : "");
		this.hintEl.setText("");
	}

	private revealCurrent(smooth: boolean): void {
		const el = this.items[this.index];
		if (!el) return;
		const list = this.listEl;
		const top = el.offsetTop;
		const bottom = top + el.offsetHeight;
		if (top >= list.scrollTop && bottom <= list.scrollTop + list.clientHeight) return;
		list.scrollTo({
			top: Math.max(0, top - (list.clientHeight - el.offsetHeight) / 2),
			behavior: smooth ? "smooth" : "auto",
		});
	}

	// ---- playback ---------------------------------------------------------

	private async mount(index: number, time: number, play: boolean): Promise<void> {
		this.destroyPlayer();
		this.screen.empty();
		const previous = this.index;
		this.index = index;
		this.paintCurrent(previous);
		this.revealCurrent(false);

		const video = this.playlist.videos[index];
		let YT: any = null;
		try {
			YT = await loadYouTubeApi(this.containerEl.win);
		} catch (e) {
			console.warn("[youtube-playlist-player]", e);
		}
		if (this.gone) return;

		// Build the iframe ourselves so we control the referrer policy.
		const iframe = this.screen.createEl("iframe", {
			cls: "ytpl-iframe",
			attr: {
				src: embedUrl(video.id, time, play),
				title: video.title,
				allow: "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen",
				referrerpolicy: "strict-origin-when-cross-origin",
				frameborder: "0",
			},
		});
		iframe.allowFullscreen = true;
		this.iframe = iframe;

		if (!YT) {
			this.hintEl.setText("Couldn't reach YouTube's player API, so autoplay and progress saving are off. Videos still play.");
			return;
		}

		this.yt = new YT.Player(iframe, {
			events: {
				onReady: () => {
					this.ready = true;
					if (this.pending) {
						const p = this.pending;
						this.pending = null;
						this.yt.loadVideoById({ videoId: this.playlist.videos[p.index].id, startSeconds: p.time });
					}
				},
				onStateChange: (e: any) => this.onState(e.data),
				onError: (e: any) => this.onPlayerError(e.data),
			},
		});
	}

	private playIndex(i: number, time = 0): void {
		const v = this.playlist.videos[i];
		if (!v || v.unavailable) return;

		// Nothing mounted (e.g. handed off to a pane): start fresh here.
		if (!this.iframe) {
			void this.mount(i, time, true);
			return;
		}

		const previous = this.index;
		this.index = i;
		this.paintCurrent(previous);
		this.revealCurrent(true);
		this.plugin.setProgress(this.playlist.id, { videoId: v.id, time });

		if (this.yt) {
			if (this.ready) this.yt.loadVideoById({ videoId: v.id, startSeconds: time });
			else this.pending = { index: i, time };
		} else {
			this.iframe.src = embedUrl(v.id, time, true);
		}
	}

	private nextIndex(direction: 1 | -1): number | null {
		const vids = this.playlist.videos;
		if (this.shuffle && direction === 1) {
			const pool = vids.map((v, i) => i).filter((i) => i !== this.index && !vids[i].unavailable);
			return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
		}
		for (let i = this.index + direction; i >= 0 && i < vids.length; i += direction) {
			if (!vids[i].unavailable) return i;
		}
		return null;
	}

	private step(direction: 1 | -1, manual: boolean): void {
		const n = this.nextIndex(direction);
		if (n !== null) this.playIndex(n);
		else if (manual) new Notice(direction === 1 ? "That's the last video." : "That's the first video.");
	}

	private onState(state: number): void {
		// -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
		this.playing = state === 1 || state === 3;
		this.layout.toggleClass("is-playing", this.playing);

		if (state === 1) this.startTicker();
		else this.stopTicker();

		if (state === 2) this.saveProgress();
		if (state === 0) {
			const v = this.playlist.videos[this.index];
			if (v) this.plugin.setProgress(this.playlist.id, { videoId: v.id, time: 0 });
			if (this.autoplay) this.step(1, false);
		}
	}

	private onPlayerError(code: number): void {
		if (code === 153) {
			this.hintEl.setText("YouTube refused to load the player (error 153). This is fixed in Obsidian 1.10.3 and later. Update Obsidian, or restart it and try again.");
			return;
		}
		const v = this.playlist.videos[this.index];
		const blocked = code === 100 || code === 101 || code === 150;
		this.hintEl.setText(
			blocked
				? "This video can't be played here (removed, private, or embedding is turned off). Use the YouTube button to open it there."
				: `YouTube couldn't play this video (error ${code}).`
		);
		if (blocked && this.autoplay && v) {
			const n = this.nextIndex(1);
			if (n !== null) this.containerEl.win.setTimeout(() => !this.gone && this.playIndex(n), 1500);
		}
	}

	private currentTime(): number {
		try {
			return Number(this.yt?.getCurrentTime?.() ?? 0) || 0;
		} catch {
			return 0;
		}
	}

	private saveProgress(): void {
		if (!this.playlist || !this.ready || this.index < 0) return;
		const v = this.playlist.videos[this.index];
		if (v) this.plugin.setProgress(this.playlist.id, { videoId: v.id, time: this.currentTime() });
	}

	private startTicker(): void {
		this.stopTicker();
		this.ticker = this.containerEl.win.setInterval(() => this.saveProgress(), 5000);
	}

	private stopTicker(): void {
		if (this.ticker !== null) {
			this.containerEl.win.clearInterval(this.ticker);
			this.ticker = null;
		}
	}

	private destroyPlayer(): void {
		this.stopTicker();
		try {
			this.yt?.destroy?.();
		} catch {
			/* the iframe may already be gone */
		}
		this.yt = null;
		this.ready = false;
		this.pending = null;
		this.playing = false;
		this.iframe?.remove();
		this.iframe = null;
	}

	// ---- actions ----------------------------------------------------------

	private popOut(): void {
		const v = this.playlist.videos[this.index];
		if (!v || !this.opts.onPopOut) return;
		const state: PopOutState = { videoId: v.id, time: this.currentTime(), playing: this.playing };
		this.resumeTime = state.time;
		this.destroyPlayer();
		this.screen.empty();

		const box = this.screen.createDiv({ cls: "ytpl-placeholder" });
		box.createDiv({ text: "Playing in the side pane" });
		const back = box.createEl("button", { text: "Play here instead" });
		back.addEventListener("click", () => void this.mount(this.index, this.resumeTime, true));

		this.opts.onPopOut(state);
	}

	private async refresh(): Promise<void> {
		const currentId = this.playlist.videos[this.index]?.id;
		try {
			this.playlist = await loadPlaylist(this.link.playlistId, this.plugin.settings.apiKey, true);
		} catch (e) {
			new Notice(`Couldn't reload the playlist: ${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		if (this.gone) return;
		this.index = this.playlist.videos.findIndex((v) => v.id === currentId);
		this.renderList();
		this.paintCurrent(-1);
		this.revealCurrent(false);
		new Notice(`Playlist reloaded (${this.playlist.videos.length} videos).`);
	}
}
