# Obsidian's YouTube Playlist Player

Watch a YouTube playlist inside your notes. Paste a playlist link and get a player with the full video list beside it, so you can pick any video without leaving Obsidian.

## Features

- Paste a playlist link into a note and it becomes a player automatically
- Video on the left, scrollable list on the right (the list moves under the video in narrow panes)
- Thumbnails, durations, a filter box, and a highlight on the video that's playing
- Previous, next, autoplay-next and shuffle
- Move playback into a pane beside your note, so the video keeps playing while you write
- Remembers the last video and time for each playlist
- No account or API key needed

## Requirements

Obsidian **1.10.3 or newer**. Older versions can't play YouTube embeds ("Error 153").

## Install

**From Community plugins** (once listed): Settings > Community plugins > Browse, search for "YouTube Playlist Player", Install, Enable.

**Manual:** download `main.js`, `manifest.json` and `styles.css` from the latest release into `<your vault>/.obsidian/plugins/youtube-playlist-player/`, then enable the plugin.

**With BRAT:** add this repository's address in the BRAT plugin to install and auto-update.

## Use

1. Copy a public playlist link, for example `https://www.youtube.com/playlist?list=PL...`
2. Paste it into a note. It turns into a block like this:

   ````
   ```youtube-playlist
   https://www.youtube.com/playlist?list=PL...
   ```
   ````

3. Click any video in the list to play it.
4. Use the pane button under the video to keep watching while you scroll or take notes.

Commands (Ctrl/Cmd+P): **Insert YouTube playlist** and **Open YouTube playlist in a pane**.

A link to a video inside a playlist (`watch?v=…&list=…`) starts the player on that video.

## Settings

- **Convert pasted playlist links**: turn the paste behavior off if you prefer plain links. Ctrl/Cmd+Z right after pasting also restores the plain link.
- **Play the next video automatically**
- **Remember where I stopped**
- **Video list width**
- **YouTube Data API key** (optional): see below.

## Troubleshooting

- **"Couldn't load this playlist"**: the playlist must be public or unlisted. Private playlists and auto-generated mixes (links with `list=RD…`) can't be read. Press **Copy debug info** in the error box and include it if you report a problem.
- **Only 15 or 200 videos appear**: YouTube sometimes only allows a partial list without a key. Add a free YouTube Data API key in settings to load everything.
- **"Error 153"**: update Obsidian to 1.10.3 or newer, then restart it.
- **A video won't play**: some owners disable embedding. Use the YouTube button under the player to open it on YouTube.

## Optional: YouTube Data API key

The plugin works without one. If YouTube changes its website and loading breaks, or you have very large playlists:

1. Go to the Google Cloud Console and create a project.
2. Enable **YouTube Data API v3** for it.
3. Create an API key (Credentials > Create credentials > API key).
4. Paste it into the plugin settings.

The key is stored only in this plugin's `data.json` inside your vault.

## Network use

This plugin contacts the following services. It has no analytics and sends nothing to the author.

- `youtube.com`: to read public playlist information (title, videos, durations)
- `googleapis.com`: only if you add an API key, to read the same information through the official API
- `i.ytimg.com`: video thumbnails
- `youtube-nocookie.com` and `youtube.com/iframe_api`: the embedded YouTube player

## Disclaimer

Not affiliated with or endorsed by YouTube or Google. Videos are played through YouTube's official embedded player.

## Development

    npm install
    npm run dev      # watch mode
    npm run build    # type-check and produce main.js
