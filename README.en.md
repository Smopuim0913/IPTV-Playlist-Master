# IPTV Playlist Master

> Simplified Chinese version lives in **[README.md](README.md)**.

> **Disclaimer**: this tool only processes playlists you already own. It ships no IPTV sources,
> provides no proxies, and proxies none — probing and playback stay on your machine, and every
> stream URL is imported by hand.

Not just an editor — this tool chains **check · edit · update** in one pass: import an m3u / m3u8
playlist, probe every source in bulk to see whether it actually plays and what resolution /
latency it has, clean or fill the channel names, then save back over the file or export a copy.
Zero third-party dependencies; Node 18+ and it runs.

## Quick start

```bash
npm start          # http://localhost:8777 by default
PORT=9200 npm start
npm test           # 31 test suites
```

## What it does

- **Open** a local file, read it by absolute path, fetch a remote URL, drop a file on the page, or paste m3u text
- **Table view** — channel name, group, tvg-id, LOGO, stream URL, resolution, latency, throughput, live status
- **Multi-select** (checkbox / Ctrl / Shift / select-all / select-by-group), drag to reorder, inline editing, add channels
- **Bulk speed probe** — concurrent probing with streaming SSE results; parses `RESOLUTION` / `BANDWIDTH`
  out of HLS master playlists and downgrades them to 480p / 720p / 1080p; measures DNS / TCP / TTFB / total
  time plus first-segment throughput, and flags a stutter risk
- **Fill resolution / fill latency / strip suffixes** — three independent actions
- **Merge from source** — pulls the remote list and merges it, never overwriting fields you edited locally
- **Overwrite save** back to the original file, or **export** `.m3u` / `.m3u8`

## Why not a pure web page

Probing IPTV sources straight from the browser hits CORS — virtually no source sends CORS headers.
Here a local Node service does the requesting: the UI stays a normal web page, and no desktop
toolchain (Tauri / Electron) is needed. Nothing leaves the machine — playlists and probe results stay local.

## Why not a desktop app either

Two things look like they need an exe but are purely server-side, and the web UI gets them anyway:

- **Reading the resolution from the video stream header** — when the stream or its HLS sub-playlist
  omits `RESOLUTION`, the service pulls the first few KB and finds the dimensions in the byte stream
  (MPEG-TS: PAT/PMT → video PID → PES → SPS; MP4/fMP4: `moov > trak > ... > stsd`). No in-process decoding.
- **Handing streams to a local player** — the browser can `spawn`-nothing, but the service runs on the
  same machine, so it spawns VLC / mpv / PotPlayer and passes the URL. The inline `▶` just POSTs the URL
  to `/api/open`.

So this is a "web UI + local service", not a packaged desktop app.

## Non-lossy export

Most existing m3u editors drop vendor-private attributes on save: `response-time`, `catchup`,
`catchup-source`, `timeshift` are not part of the standard EXTINF, and a re-serializer that only
writes back the fields it knows about ruins a provider-supplied list the moment you save it.

This project holds one rule: **edit what you touched, export everything else byte-for-byte**.
`parseExtinf` keeps each attribute's **original raw token** and its order, and the serializer writes
it back as-is, so quotes, single quotes, bare values, and private forms like `response-time={18}ms`
survive. File-header comments (`#KODIPROP`), comments between entries, trailing comments, CRLF line
endings, the final newline, and a UTF-8 BOM are all round-tripped exactly — read → edit → export is
idempotent.

On encoding: reading auto-detects UTF-8 / GB18030 / Latin-1, and writing is always UTF-8 with the
original line endings and BOM preserved. Exports then split by extension — `.m3u8` follows RFC 8216
(UTF-8, and a BOM is forbidden) so the BOM is dropped, while `.m3u`, whose de-facto Winamp-era
standard never specified an encoding, keeps whatever the source file had (cover-save included).
MIME matches too: `.m3u` is `audio/x-mpegURL`, `.m3u8` is the `application/vnd.apple.mpegurl`
that Safari / iOS plays natively.

## Playing with one window

The inline `▶` opens the selected channel in a local player. When several channels are selected,
the button becomes **"Queue into one window (N)"**: one playlist is written to a temp `.m3u`
(channel names go into the `#EXTINF` lines) and handed to **a single** player process, so exactly
one stream plays at a time instead of several mixing together. Clicking again **appends to that same
window** (VLC's HTTP interface, random port + random password, loopback only). Close that window and
it gets relaunched next time.

"Audio but no picture" is a Windows foreground-activation limit: the service process owns no window,
so a spawned player lands behind the browser and `SetForegroundWindow` is rejected outright. The page
raises a **"Bring player window to front"** bar — a real click is what actually relinquishes foreground
rights.

## Detection details

Latency is TTFB (time to first byte), **not ping** — ICMP takes its own path, and an 8 ms ping can
still stutter. Judgment of stuttering really comes from bandwidth (1080p wants ~8 Mbps or more).

Three layers of tolerance, because 120 concurrent probes mostly produce false dead links from jitter:

1. instant failures (timeout / ECONNRESET / transient DNS / 5xx / 429) are retried up to 3 attempts
   total with jittered backoff; the status tooltip states how many attempts were made
2. a 403 is retried with a player UA — many sources only allow player UAs, and a success is noted as such
3. same-host serial gate — at least 0.2 s between requests to one host, so you don't trip rate limits

Permanent errors (NXDOMAIN, 404) are not retried. Certificate errors still get the single
"insecure TLS" chance, and from then on nothing is promised about playability — try it in VLC.

## Layout

```
src/m3u.js           parse / serialize (lossless round-trip, keeps private attributes)
src/probe.js         stream probe (DNS/TCP/TTFB/throughput, HLS variant parsing, stutter risk)
src/resolution.js    reads the resolution out of TS / MP4 / first-segment headers
src/player.js        local player discovery + opening streams (spawned server-side)
src/merge.js         merge updates from the source (locally edited fields are never overwritten)
src/suffix.js        suffix stripping / writing on channel names
src/sort.js          sort same-named channels by latency
src/server.js        zero-dependency HTTP server + SSE streaming probe
public/              frontend table + i18n (zh-CN / en)
sample/              sample playlist (various private attribute spellings, some dead links)
test/                test suites
```

## Encoding

Files are decoded as utf-8 → gb18030 → latin1, in that order. Non-UTF-8 lists are written back out
as UTF-8, and the page tells you so at the top — nothing is silently rewritten.
