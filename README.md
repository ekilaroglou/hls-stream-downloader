# HLS Stream Downloader

A Chrome extension (Manifest V3) that saves HLS video streams (`.m3u8`) from the page you are watching as a
single MP4 file: one click, audio included. It also records live streams.

## Features

- **Save loaded part** collects cacheable media parts as the player loads them. The latest response for a part
  determines whether it counts as loaded. Chrome may request a part again if its cached copy is unavailable.
  **Download full video** also requests parts the player hasn't loaded yet.
- Finds HLS playlists on any page: by URL and content type, and by content (`#EXTM3U`) while the page's player
  loads them, so API addresses, service-worker responses and playlists built by the player also work.
- Picks the best quality, including a separate audio track if the stream has one, and combines everything into
  one MP4 without re-encoding. Formats the browser can't convert (for example HEVC or MP3 in MPEG-TS) are saved
  as they are.
- Records live streams until you press **Stop and save**, or until the stream ends.
- Loads the video from inside the page that plays it, so requests carry the page's own origin, referrer and
  cookies, like the site's player. Nothing is spoofed.
- Three speeds for **Download full video**: Normal (4×) and Fast (16× playback speed) load about 30 seconds ahead
  like a player, then keep a steady pace with at most 6 new requests a second; Max has no pace and sends up to
  16 requests at a time (MPEG-TS is converted to MP4 on background threads while downloading). Parts the page
  served from cache don't count toward the pace. The speed can be changed while a download runs.
- If the site answers 429 or 503 ("too many requests"), no new requests start until the wait it asks for
  (`Retry-After`) is over, or for a second if it gives none. Max then sends half as many requests at a time (and
  later tries one more again, staying below the number the site turned down); Normal and Fast, and Max at one
  request at a time, continue one speed slower (never with more requests at a time). Retries wait their turn like
  new requests, and nothing at all is sent while the site asked to wait. Sites often have a quota per time window,
  so once nothing can be lowered any more, a single test request is sent after waits that double (2 s, 4 s, … up
  to 5 minutes, about half an hour in all) until the site answers again; the download page counts down.
- Saves to the Downloads folder, a folder you choose in Settings, or asks every time (Save As). A chosen folder is
  kept as a folder handle (Chrome never gives extensions its full path); when Chrome's access to it has lapsed, the
  download page asks with one click, or saves to Downloads instead.
- The download page shows each step with its own progress: downloading (parts count once they are in the file,
  converted if needed), finishing the MP4, putting the video together, waiting for another download to finish
  saving, saving (bytes written), and Chrome finishing the file on the drive. It never shows 100% before the file
  is saved. Saves from several download tabs take turns (Web Locks), which is quicker on hard and external drives.
- The download page has two sections that open with an arrow: **Activity** (what it is doing, in plain words:
  parts downloaded, in the file, converting, requests waiting for an answer, retries, and a history) and
  **Developer log** (numbers and errors to copy and share: every refused or unanswered request, slow answers,
  timings per step, snapshots every 5 s; hosts are labelled A, B…, parts by number; no addresses, site names,
  titles, folder or file names).
- Pauses when the page reloads or a signed link expires, and continues by itself when the video plays again on the
  same page, even if the site hands out new addresses (a new session path or token). Before continuing it makes sure
  it is the same video and quality: the same parts with the same durations, and parts it already has must have
  exactly the same content in the reloaded playlist. It compares the last part kept (where the download goes on;
  videos can share an intro), the first and a middle one, plus the last audio part: at most a few requests, not the
  whole video again. With **Save loaded part** it only compares parts the page has loaded again, so it continues
  once the player reaches the last part it already has. A different video or quality leaves the download paused
  (what was collected can still be saved). If both the page and the playlist are at new addresses, it doesn't
  continue by itself (another video can start with the same intro, so content alone can't tell); **Resume** then
  continues after the same checks.
- A part that comes back empty or cut short is asked for again; if it keeps coming back that way, the download
  pauses instead of saving a file with a hole.
- The download tab opens with a short random link (`downloader.html#id`); the video address and tokens stay in
  the extension's session storage and are deleted after saving, or after 30 minutes.
- Supports AES-128 encryption, fragmented MP4 (CMAF), byte ranges, `#EXT-X-GAP`, discontinuities, redirects and
  CDNs that need the site's cookies. DRM-protected streams are refused.

## Development

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and select this folder.
2. After changing code, click the extension's reload button and reload the pages you test on.
3. `npm test` (or `node --test`) runs the tests in `tests/` (Node 18 or newer; no packages needed).

Run the regression tests with `npm test` (Node.js 18 or later).

Usage: open a page with an HLS video, press play, click the toolbar icon, then **Download** (or **Record**).

## Publishing

- `node scripts/package.mjs` builds `dist/hls-stream-downloader-<version>.zip` (only the extension's files).
  Raise `version` in `manifest.json` for every new upload.
- `store/listing.md` has the text for every field of the Chrome Web Store dashboard.
- `store/PRIVACY.md` and `store/privacy-policy.html` are the privacy policy (contact: the repository's Issues page; host
  the HTML page at a public URL; `store/listing.md` has the GitHub Pages steps).
- `store/images/` has the store icon, the screenshots and the small promo tile.
- The icons are an orange tile with a white video screen, a play button and a download arrow; 16 and 32 px use
  simplified, bolder shapes so they stay clear in the toolbar.

## How it works

| Path | Purpose |
|---|---|
| `background.js` | Detects playlists from network requests; notes which video parts each tab loaded (hashes); session storage |
| `content/hook.js` | Runs in the page; recognizes playlists by content as the player loads them (read-only) |
| `content/relay.js` | Passes found playlists from the page to the background script |
| `content/page-fetch.js` | Runs in the video's frame on demand and makes the requests there |
| `popup.*` | Lists the videos on the page, one button each |
| `downloader.*` | Download page: progress, live recording, automatic resume, saving |
| `options.*` | Settings (opens in a tab): speed (also switchable on the download page) and where videos are saved |
| `lib/save-location.js` | Save to: the chosen folder (IndexedDB handle, write access, no-overwrite names) |
| `lib/m3u8.js` | Playlist parser |
| `lib/download.js` | Download engine: pacing and request limit, slowing down on 429/503, ordering, decryption, separate audio, live, resume, "Save loaded part" |
| `lib/loaded.js` | Which segments the page already loaded; picks the quality the page loaded most of |
| `lib/icons.js` | Line icons used by the pages |
| `lib/devlog.js` | Developer log: request records, step timings, summary; hides addresses and names |
| `lib/streams.js` | Counts the videos on a tab (qualities, audio, subtitles and previews belong to their master) |
| `lib/mp4.js` | Reads MP4 fragments and writes one MP4 (tracks combined, timeline from 0) |
| `lib/converter.js`, `lib/convert-worker.js` | MPEG-TS to MP4 conversion with mux.js on background threads (Web Workers) |
| `lib/toolbar-icon.js` | Toolbar icon with a small count of the videos found |
| `lib/formats.js` | Recognizes segment formats (MP4, MPEG-TS codecs, packed audio) |
| `lib/fetcher.js` | Retries, expired-link detection, cookie retry |
| `lib/page-fetch.js` | Extension side of the page connection; reuses captured playlists |
| `vendor/mux.min.js` | [mux.js](https://github.com/videojs/mux.js) 7.0.3 (Apache-2.0), MPEG-TS → MP4 |

## Privacy

Everything runs in the browser; nothing is sent to the developer or third parties. See `store/PRIVACY.md`.

## Limitations

- DRM (Widevine, PlayReady, FairPlay, SAMPLE-AES) is not supported.
- DASH (`.mpd`) streams are not detected.
- Subtitles are not saved.
- The whole video is assembled before saving; very long videos need free disk space of about twice the file size.

Only download videos you have the right to save, and respect each website's terms.

Third-party licenses: `THIRD_PARTY_NOTICES.txt`.
