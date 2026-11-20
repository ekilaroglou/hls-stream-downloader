# Chrome Web Store submission — HLS Stream Downloader

Everything to fill in on the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole),
field by field. The upload file is built with `node scripts/package.mjs` (see the README).

## Before you submit

1. **Developer account:** register on the dashboard (one-time registration fee) and verify your contact email.
2. **Trader declaration:** the dashboard asks whether you are a trader under EU law. Answer for your situation;
   traders must publish contact details.
3. **Privacy policy:** put your contact email into `store/privacy-policy.html` (replace `[your contact email]`
   near the end) and into `store/PRIVACY.md`. Then publish it with GitHub Pages:
   - Push this folder to a **public** GitHub repository.
   - In the repository: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, branch
     `main`, folder `/ (root)`, **Save**.
   - After a minute the policy is at `https://<your-user>.github.io/<repository>/store/privacy-policy.html`.
     Open it once in a private window to check it loads, then paste that address in the Privacy tab.
   - The repository page itself (`https://github.com/<your-user>/<repository>`) can be the Homepage and Support URL.
4. **Upload:** `dist/hls-stream-downloader-1.0.0.zip`.

Note: Google allows video downloaders in the store but doesn't feature them in its promotions. The relevant
rule is that products must not "encourage, facilitate, or enable the unauthorized access, download, or
streaming of copyrighted content." The listing below says that only videos the user has the right to save
should be downloaded, and the extension refuses DRM-protected streams.

---

## Store listing tab

**Title** (from the manifest): HLS Stream Downloader

**Summary** (from the manifest, 126 of 132 characters):
Save HLS (.m3u8) videos and live streams from the page you are watching as MP4 files. One click, and nothing is sent anywhere.

**Description:**

```
HLS Stream Downloader saves the streaming video you are watching as a regular MP4 file.

Many websites play video as HLS: a playlist (.m3u8) that lists hundreds of short segments. This extension notices those playlists while the page plays, then joins the segments into one file you can keep and play anywhere.

HOW IT WORKS
1. Open the page and press play.
2. Click the extension icon. Each video on the page is listed once, with how much of it your browser has already loaded.
3. Click Save loaded part, Download full video, or Record for a live stream. The file goes to your Downloads folder, or the folder you chose in Settings.

TWO WAYS TO SAVE
• Save loaded part: saves what your browser has already streamed, instantly, straight from Chrome's cache. It makes no new requests to the website and keeps adding parts while the video plays.
• Download full video: also loads the parts the player hasn't loaded yet, at the speed you choose.

FEATURES
• Download full video picks the best quality automatically, with the audio included, even when the site keeps the audio in a separate stream
• Saves as MP4 without re-encoding, so the quality stays the same; formats the browser can't convert are saved as they are (.ts)
• Records live streams until you press Stop and save
• Finds playlists by their content, so it also works when the address doesn't end in .m3u8
• Loads the video from the page itself, with the same cookies and settings as the site's own player
• Three speeds: Normal (the default: a steady pace like a video player buffering ahead, gentle on websites), Fast, or Max (as fast as your connection allows). Choose in Settings, or switch while a download runs
• Save to your Downloads folder, a folder you choose, or pick a place each time
• Slows down by itself if a website answers that it's getting too many requests
• Pauses and continues by itself if the page reloads or a signed link expires
• Short private download links: video addresses are never shown, and download details are deleted after saving or after 30 minutes
• Handles standard AES-128 encrypted streams, fragmented MP4 (CMAF), byte ranges, gaps and discontinuities

PRIVACY
Everything happens in your browser. The extension has no servers, analytics, ads or tracking, and sends nothing to the developer.

PLEASE NOTE
• DRM-protected streams (Widevine, PlayReady, FairPlay) are not supported.
• Only download videos you have the right to save, and respect each website's terms.
```

**Category:** Tools

**Language:** English

**Graphic assets** (in `store/images/`):

| Field | File | Size |
|---|---|---|
| Store icon | `store-icon-128.png` (same as `icons/icon128.png` in the package) | 128×128, 96×96 artwork with transparent padding |
| Screenshot 1 | `screenshot-1-popup.png` | 1280×800 |
| Screenshot 2 | `screenshot-2-save-loaded.png` | 1280×800 |
| Screenshot 3 | `screenshot-3-download-all.png` | 1280×800 |
| Screenshot 4 | `screenshot-4-live.png` | 1280×800 |
| Screenshot 5 | `screenshot-5-settings.png` | 1280×800 |
| Small promo tile | `promo-small-440x280.png` | 440×280 |
| Marquee promo tile | not needed (only used when an item is featured) | 1400×560 |

The screenshots were taken from the real extension on a demo page (`videos.example.com`, a reserved example
domain) with generated demo video.

**Homepage URL / Support URL:** the GitHub repository page (`https://github.com/<your-user>/<repository>`).
Leave **Official URL** empty (it needs a verified domain).

**Mature content:** No.

---

## Privacy tab

**Single purpose description:**

```
Saves HLS video streams that the current web page plays as a video file on the user's computer. The user opens the popup on a page that plays a video and clicks Save loaded part, Download full video, or Record for a live stream.
```

**Permission justifications:**

| Permission | Justification |
|---|---|
| `webRequest` | Observes the network requests that web pages make, to notice when a page loads an HLS video playlist (URLs ending in .m3u8, or responses with an HLS content type) and which video parts it has finished loading. Requests are never blocked or changed. Only playlist addresses and short hashes of loaded video parts are kept, in session storage for that tab, so parts already in the browser can be saved without new requests. |
| `scripting` | Injects a small script into the frame that plays the video when the user opens the popup or starts a download. It requests the playlist and video segments from inside that page, so they load the same way the page's own video player loads them. |
| `downloads` | Saves the finished video file to the user's Downloads folder. |
| `storage` | Session storage remembers which videos and loaded parts were found on each open tab (cleared when the tab is closed) and the details of a running download, so its tab can use a short private link; those details are deleted after saving or after 30 minutes. Local storage remembers the user's settings (download speed, where to save). If the user picks a save folder in Settings, its folder handle is kept in the extension's IndexedDB. |
| Host permission (`<all_urls>`) and content scripts on all sites | Videos can be on any website and are often served from another domain (a CDN). The extension needs access to detect video playlists on the page the user is watching and to load the video from that page when the user asks for it. The content script recognizes HLS playlists by their content (#EXTM3U) while the page's player loads them, including playlists whose address doesn't end in .m3u8. It reads responses without changing them and sends nothing off the device. |

**Are you using remote code?** No, I am not using remote code. (All code, including the mux.js library, is
in the package.)

**Data usage — what user data does the extension collect?**

Google's FAQ says that data which is only handled locally must also be disclosed. Tick:

- [x] **Website content** — the extension reads HLS playlists that pages load and downloads the video the
  user asks for.
- [x] **User activity** — Google's examples for this category include network monitoring; the extension
  observes request addresses to find playlists. (Check the dashboard's description of each category when you
  fill this in.)

Leave everything else unticked: no personally identifiable information, health, financial, authentication,
personal communications, location or web history.

Tick all three certifications:

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases.
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** the public address where you host `store/privacy-policy.html`.

---

## Distribution tab

- **Visibility:** Public (or Unlisted to share it with a link first).
- **Regions:** all regions, unless you want to limit them.
- **Pricing:** free.

## Test instructions for reviewers (if the dashboard asks)

```
1. Open any web page that plays an HLS (.m3u8) video and press play.
2. Click the extension's toolbar icon. The video appears with "Save loaded part" and "Download full video" (Record for live streams).
3. Click either. A tab shows the progress; the MP4 file is saved to the Downloads folder (or the folder chosen in Settings).
4. Settings (link in the popup) changes the download pace and where files are saved; the speed switch on the download page changes the pace while downloading.
No account, login or configuration is needed. The extension sends no data anywhere.
```
