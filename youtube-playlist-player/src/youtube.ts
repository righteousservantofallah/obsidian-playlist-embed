import { requestUrl } from "obsidian";

export interface VideoItem {
	id: string;
	title: string;
	channel: string;
	/** Length in seconds, 0 when unknown. */
	duration: number;
	thumb: string;
	/** Private, deleted or otherwise not playable. */
	unavailable: boolean;
}

export interface Playlist {
	id: string;
	title: string;
	videos: VideoItem[];
	/** Shown under the list when the playlist could only be loaded partially. */
	note?: string;
}

/** Thrown when every loading strategy failed; `details` is safe to paste into a bug report. */
export class PlaylistLoadError extends Error {
	constructor(message: string, public details: string) {
		super(message);
	}
}

export interface ParsedLink {
	playlistId: string;
	/** Set when the link also points at a specific video (watch?v=…&list=…). */
	startVideoId?: string;
}

/** Returns null unless the text is a single YouTube link that contains a list= parameter. */
export function parsePlaylistUrl(input: string): ParsedLink | null {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		return null;
	}
	const host = url.hostname.replace(/^(www|m|music)\./, "");
	if (!["youtube.com", "youtu.be", "youtube-nocookie.com"].includes(host)) return null;

	const list = url.searchParams.get("list");
	if (!list || !/^[\w-]{10,}$/.test(list)) return null;

	let video = url.searchParams.get("v") ?? undefined;
	if (!video && host === "youtu.be") video = url.pathname.slice(1) || undefined;
	return {
		playlistId: list,
		startVideoId: video && /^[\w-]{11}$/.test(video) ? video : undefined,
	};
}

export function formatDuration(totalSeconds: number): string {
	const s = Math.max(0, Math.floor(totalSeconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = String(s % 60).padStart(2, "0");
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

// ---------------------------------------------------------------------------
// Loading
//
// YouTube changes its page format from time to time, so we try several
// strategies in order and use the first one that returns videos:
//   1. the public playlist page (parses both the old and the new layout)
//   2. YouTube's internal "browse" endpoint (same data, no HTML)
//   3. YouTube's internal "next" endpoint (first ~200 videos)
//   4. the playlist's public RSS feed (latest 15 videos)
// ---------------------------------------------------------------------------

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; playlist: Playlist }>();

export async function loadPlaylist(id: string, apiKey: string, force = false): Promise<Playlist> {
	const hit = cache.get(id);
	if (hit && !force && Date.now() - hit.at < CACHE_MS) return hit.playlist;

	const log: string[] = [];
	const finish = (playlist: Playlist): Playlist => {
		cache.set(id, { at: Date.now(), playlist });
		return playlist;
	};

	if (apiKey) {
		try {
			return finish(await viaDataApi(id, apiKey));
		} catch (e) {
			log.push(`dataApi: ${errorText(e)}`);
		}
	}

	const session: Session = {};
	const strategies: Array<[string, () => Promise<Playlist>]> = [
		["page", () => viaPage(id, session, log)],
		["browse", () => viaBrowse(id, session, log)],
		["next", () => viaNext(id, session, log)],
		["rss", () => viaRss(id)],
	];

	for (const [name, run] of strategies) {
		try {
			const playlist = await run();
			if (playlist.videos.length > 0) return finish(playlist);
			log.push(`${name}: returned 0 videos`);
		} catch (e) {
			log.push(`${name}: ${errorText(e)}`);
		}
	}

	throw new PlaylistLoadError(
		"No videos found. The playlist may be private, empty, or an auto-generated mix.",
		`youtube-playlist-player debug\nplaylist: ${id}\n${log.join("\n")}`
	);
}

function errorText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Session {
	key?: string;
	version?: string;
}

// ---- parsing helpers -------------------------------------------------------

function walk(node: unknown, visit: (key: string, value: any) => void): void {
	if (Array.isArray(node)) {
		for (const child of node) walk(child, visit);
	} else if (node && typeof node === "object") {
		for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
			visit(key, value);
			walk(value, visit);
		}
	}
}

function textOf(x: any): string {
	if (!x) return "";
	if (typeof x === "string") return x;
	if (typeof x.simpleText === "string") return x.simpleText;
	if (typeof x.content === "string") return x.content;
	if (Array.isArray(x.runs)) return x.runs.map((r: any) => r.text ?? "").join("");
	return "";
}

function clockToSeconds(text: string): number {
	if (!/^\d{1,3}(:\d{2}){1,2}$/.test(text)) return 0;
	return text.split(":").reduce((acc, part) => acc * 60 + parseInt(part, 10), 0);
}

const UNAVAILABLE_TITLE = /^\[?(private|deleted) video\]?$/i;

const thumbOf = (id: string) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;

/** Old layout: playlistVideoRenderer */
function fromRenderer(v: any): VideoItem {
	const id = String(v.videoId);
	const title = textOf(v.title) || "Untitled video";
	return {
		id,
		title,
		channel: textOf(v.shortBylineText),
		duration: parseInt(v.lengthSeconds ?? "0", 10) || 0,
		thumb: thumbOf(id),
		unavailable: v.isPlayable === false || UNAVAILABLE_TITLE.test(title),
	};
}

/** New layout: lockupViewModel (video id lives in contentId). */
function fromLockup(v: any): VideoItem | null {
	const id = v?.contentId;
	const type = String(v?.contentType ?? "");
	if (typeof id !== "string" || !/^[\w-]{11}$/.test(id)) return null;
	if (type && !type.includes("VIDEO")) return null;

	const meta = v?.metadata?.lockupMetadataViewModel;
	const title = textOf(meta?.title) || "Untitled video";

	let channel = "";
	const rows = meta?.metadata?.contentMetadataViewModel?.metadataRows ?? [];
	for (const row of rows) {
		for (const part of row?.metadataParts ?? []) {
			const t = textOf(part?.text);
			if (t && !channel && !/\b(views?|ago|watching|waiting)\b/i.test(t)) channel = t;
		}
	}

	let duration = 0;
	walk(v?.contentImage, (key, value) => {
		if (!duration && key === "text" && typeof value === "string") duration = clockToSeconds(value.trim());
	});

	return { id, title, channel, duration, thumb: thumbOf(id), unavailable: UNAVAILABLE_TITLE.test(title) };
}

function collectFrom(root: unknown, videos: VideoItem[]): void {
	walk(root, (key, value) => {
		if (key === "playlistVideoRenderer" && value?.videoId) videos.push(fromRenderer(value));
		else if (key === "lockupViewModel") {
			const item = fromLockup(value);
			if (item) videos.push(item);
		}
	});
}

/**
 * Pull videos and the "load more" token out of a page or continuation response.
 * When the playlist list container is present we only read inside it, so
 * sidebar suggestions can't leak in.
 */
function collect(data: unknown): { videos: VideoItem[]; token?: string } {
	const scopes: unknown[] = [];
	let token: string | undefined;

	walk(data, (key, value) => {
		if (key === "playlistVideoListRenderer" || key === "continuationItems") scopes.push(value);
		if (key === "continuationItemRenderer") {
			const t = value?.continuationEndpoint?.continuationCommand?.token;
			if (typeof t === "string") token = t;
		}
	});

	const videos: VideoItem[] = [];
	if (scopes.length > 0) for (const scope of scopes) collectFrom(scope, videos);
	if (videos.length === 0) collectFrom(data, videos);
	return { videos, token };
}

function describe(data: unknown): string {
	const names = ["playlistVideoListRenderer", "playlistVideoRenderer", "lockupViewModel", "continuationItemRenderer", "playlistPanelVideoRenderer"];
	const counts: Record<string, number> = {};
	walk(data, (key) => {
		if (names.includes(key)) counts[key] = (counts[key] ?? 0) + 1;
	});
	const top = data && typeof data === "object" ? Object.keys(data as object).join(",") : "none";
	return `topKeys=[${top}] counts=${JSON.stringify(counts)}`;
}

function guessVersion(): string {
	// YouTube rejects very old client versions, so build one from a recent date.
	const d = new Date(Date.now() - 2 * 86400000);
	const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
	return `2.${ymd}.00.00`;
}

async function innertube(endpoint: "browse" | "next", body: Record<string, unknown>, session: Session): Promise<any> {
	const version = session.version ?? guessVersion();
	const res = await requestUrl({
		url: `https://www.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false${session.key ? `&key=${session.key}` : ""}`,
		method: "POST",
		contentType: "application/json",
		headers: {
			"X-YouTube-Client-Name": "1",
			"X-YouTube-Client-Version": version,
			Origin: "https://www.youtube.com",
			"Accept-Language": "en-US,en;q=0.9",
		},
		body: JSON.stringify({
			context: { client: { clientName: "WEB", clientVersion: version, hl: "en", gl: "US" } },
			...body,
		}),
	});
	return res.json;
}

/** Follow "continuation" tokens to get everything past the first 100 videos. */
async function followContinuations(first: { videos: VideoItem[]; token?: string }, session: Session): Promise<VideoItem[]> {
	let videos = first.videos;
	let token = first.token;
	let pages = 0;
	while (token && pages++ < 60) {
		try {
			const next = collect(await innertube("browse", { continuation: token }, session));
			if (next.videos.length === 0) break;
			videos = videos.concat(next.videos);
			token = next.token;
		} catch (e) {
			console.warn("[youtube-playlist-player] Could not load the rest of the playlist", e);
			break;
		}
	}
	return videos;
}

function playlistTitle(data: any): string {
	return (
		data?.metadata?.playlistMetadataRenderer?.title ||
		textOf(data?.header?.playlistHeaderRenderer?.title) ||
		textOf(data?.header?.pageHeaderRenderer?.pageTitle) ||
		"YouTube playlist"
	);
}

// ---- Strategy 1: the public playlist page ---------------------------------

async function viaPage(id: string, session: Session, log: string[]): Promise<Playlist> {
	const page = await requestUrl({
		url: `https://www.youtube.com/playlist?list=${encodeURIComponent(id)}&hl=en&gl=US`,
		headers: { "Accept-Language": "en-US,en;q=0.9", Cookie: "CONSENT=YES+1; SOCS=CAI" },
	});
	const html = page.text;

	session.key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
	session.version =
		html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/)?.[1] ?? html.match(/"clientVersion":"([^"]+)"/)?.[1];

	const match = html.match(/ytInitialData\s*=\s*(\{[\s\S]*?\})\s*;\s*<\/script>/);
	let data: any = null;
	try {
		data = match ? JSON.parse(match[1]) : null;
	} catch {
		data = null;
	}
	if (!data) {
		log.push(
			`page: no readable ytInitialData (htmlLength=${html.length}, consentPage=${html.includes("consent.youtube.com")}, hasKey=${!!session.key})`
		);
		return { id, title: "", videos: [] };
	}

	const first = collect(data);
	log.push(`page: ${describe(data)} found=${first.videos.length} hasToken=${!!first.token}`);
	const videos = await followContinuations(first, session);
	return { id, title: playlistTitle(data), videos };
}

// ---- Strategy 2: internal browse endpoint ---------------------------------

async function viaBrowse(id: string, session: Session, log: string[]): Promise<Playlist> {
	const data = await innertube("browse", { browseId: `VL${id}` }, session);
	const first = collect(data);
	log.push(`browse: ${describe(data)} found=${first.videos.length}`);
	const videos = await followContinuations(first, session);
	return { id, title: playlistTitle(data), videos };
}

// ---- Strategy 3: internal next endpoint (watch-page playlist panel) -------

async function viaNext(id: string, session: Session, log: string[]): Promise<Playlist> {
	const data = await innertube("next", { playlistId: id }, session);
	const panel = data?.contents?.twoColumnWatchNextResults?.playlist?.playlist;
	const videos: VideoItem[] = [];
	for (const entry of panel?.contents ?? []) {
		const v = entry?.playlistPanelVideoRenderer ?? entry?.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer;
		if (!v?.videoId) continue;
		const title = textOf(v.title) || "Untitled video";
		videos.push({
			id: String(v.videoId),
			title,
			channel: textOf(v.longBylineText) || textOf(v.shortBylineText),
			duration: clockToSeconds(textOf(v.lengthText)),
			thumb: thumbOf(String(v.videoId)),
			unavailable: UNAVAILABLE_TITLE.test(title),
		});
	}
	log.push(`next: panel=${!!panel} found=${videos.length}`);
	const total = Number(panel?.totalVideos ?? 0);
	return {
		id,
		title: textOf(panel?.title) || "YouTube playlist",
		videos,
		note: total > videos.length ? `Showing the first ${videos.length} of ${total} videos. Add a YouTube Data API key in settings to load all of them.` : undefined,
	};
}

// ---- Strategy 4: public RSS feed (latest 15 videos) -----------------------

async function viaRss(id: string): Promise<Playlist> {
	const res = await requestUrl({ url: `https://www.youtube.com/feeds/videos.xml?playlist_id=${encodeURIComponent(id)}` });
	const doc = new DOMParser().parseFromString(res.text, "application/xml");
	const videos: VideoItem[] = [];
	doc.querySelectorAll("entry").forEach((entry) => {
		const vid = entry.getElementsByTagName("yt:videoId")[0]?.textContent?.trim();
		if (!vid) return;
		videos.push({
			id: vid,
			title: entry.getElementsByTagName("title")[0]?.textContent?.trim() || "Untitled video",
			channel: entry.querySelector("author > name")?.textContent?.trim() ?? "",
			duration: 0,
			thumb: thumbOf(vid),
			unavailable: false,
		});
	});
	return {
		id,
		title: doc.documentElement.getElementsByTagName("title")[0]?.textContent?.trim() || "YouTube playlist",
		videos,
		note: "Showing only the 15 videos YouTube's feed provides. Add a YouTube Data API key in settings to load the full playlist.",
	};
}

// ---- Optional: YouTube Data API v3 (needs a free API key) -----------------

function isoToSeconds(iso: string): number {
	const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
	if (!m) return 0;
	return (parseInt(m[1] ?? "0", 10) * 3600) + (parseInt(m[2] ?? "0", 10) * 60) + parseInt(m[3] ?? "0", 10);
}

async function viaDataApi(id: string, key: string): Promise<Playlist> {
	const base = "https://www.googleapis.com/youtube/v3";

	const meta = await requestUrl({ url: `${base}/playlists?part=snippet&id=${id}&key=${key}` });
	const snippet = meta.json?.items?.[0]?.snippet;
	if (!snippet) throw new Error("Playlist not found. It may be private.");

	const videos: VideoItem[] = [];
	let pageToken = "";
	do {
		const res = await requestUrl({
			url:
				`${base}/playlistItems?part=snippet&maxResults=50&playlistId=${id}&key=${key}` +
				(pageToken ? `&pageToken=${pageToken}` : ""),
		});
		for (const item of res.json?.items ?? []) {
			const vid = item?.snippet?.resourceId?.videoId;
			if (!vid) continue;
			const title: string = item.snippet.title ?? "Untitled video";
			videos.push({
				id: vid,
				title,
				channel: item.snippet.videoOwnerChannelTitle ?? "",
				duration: 0,
				thumb: `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`,
				unavailable: title === "Private video" || title === "Deleted video",
			});
		}
		pageToken = res.json?.nextPageToken ?? "";
	} while (pageToken);

	// Durations live on a separate endpoint, 50 ids at a time.
	for (let i = 0; i < videos.length; i += 50) {
		const slice = videos.slice(i, i + 50);
		try {
			const res = await requestUrl({
				url: `${base}/videos?part=contentDetails&id=${slice.map((v) => v.id).join(",")}&key=${key}`,
			});
			const byId = new Map<string, number>();
			for (const item of res.json?.items ?? []) {
				byId.set(item.id, isoToSeconds(item.contentDetails?.duration ?? ""));
			}
			for (const v of slice) v.duration = byId.get(v.id) ?? 0;
		} catch {
			break; // durations are optional
		}
	}

	if (videos.length === 0) throw new Error("This playlist has no videos.");
	return { id, title: snippet.title ?? "YouTube playlist", videos };
}
