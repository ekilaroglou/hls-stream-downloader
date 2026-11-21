# Privacy Policy — HLS Stream Downloader

_Effective date: November 20, 2026_

HLS Stream Downloader ("the extension") saves HLS video streams that the web page you are watching plays as a
file on your computer. This policy explains what information the extension handles and what it does with it.

**In short: everything happens in your browser. The extension does not send any information to the developer
or to anyone else, and it has no servers, analytics, ads or tracking.**

## What the extension handles, and why

| Information | Why it is needed | Where it stays |
|---|---|---|
| Addresses (URLs) of network requests made by web pages, and the `Content-Type` of their responses | To notice when a page loads an HLS video playlist (`.m3u8`). Requests are only observed, never blocked or changed. Only playlist addresses are kept. | Kept in your browser's session storage for that tab only |
| Content of HLS playlists that pages load | To recognize playlists that don't end in `.m3u8`, the extension looks at the first bytes of text responses that pages receive; a playlist starts with `#EXTM3U`. Playlists are kept to list the videos and qualities without downloading them again. Other responses are not kept. | Kept in your browser's session storage for that tab only |
| Short codes (hashes) computed from the addresses and byte ranges of media parts | To identify parts the player has loaded that may still be available from the browser's cache. | Kept in your browser's session storage for that tab only |
| The details of a download you start (the video's address, the tab and its title) | So the download tab can find the video. The tab opens with a short random link (`#id`) instead of the address. | Kept in your browser's session storage; deleted when the file is saved or the download is cancelled, and after 30 minutes at the latest |
| The title of the tab you are using the extension on | Shown in the extension and used as the name of the saved file | Not stored apart from the download details above |
| Media playlists, initialization data, standard HLS AES-128 keys, and media segments | To list available streams, save the selected media, and verify retained parts when resuming. Chrome uses cached responses when available. | Processed in your browser. The finished video is saved to the destination you choose. |
| Your settings: download speed and where to save | To remember your choices | Stored in your browser's local extension storage |
| The folder you choose in Settings (if you choose one) | To save videos there. Chrome gives the extension access to that one folder only, without its full path, and asks you again from time to time | Stored in the extension's IndexedDB in your browser; replaced when you choose another folder |

Session storage is held in memory by Chrome and is not readable by websites. The extension removes a tab's
entries when the tab is closed, and Chrome clears all of it when the browser closes.

## What the extension does not do

- It does not send any data to the developer, to third parties or to any server other than the website you
  are downloading a video from.
- It does not collect personal information, browsing history, passwords, form data or payment information.
- It does not read or change your cookies. When you download a video, the requests are made from the page
  that plays it, so the website receives the same cookies and headers it already receives from your browser
  while you watch.
- It does not use analytics, advertising, tracking or remote code. All of its code is included in the
  extension package.
- It does not sell, share or transfer any data.

## Website requests made for downloads

**Save loaded part** collects media segments the player previously loaded with cacheable response headers.
The latest response for a segment or byte range determines whether it is eligible. Chrome may request an eligible
segment again if its cached copy is unavailable. Playlists, initialization data and encryption keys may also be
requested when needed. Resuming a download re-reads a few parts it already has, to verify that it is the same video.
When you click **Download full video** or **Record**, the extension requests the video's
remaining segments from the website (or its content delivery network) that serves the video, in the same way the
website's own video player does. Those requests are subject to that website's own privacy policy.

## Permissions

- **Access to websites (all sites):** videos can be on any website and are often served from other domains.
  This lets the extension detect playlists on the page you are watching and load the video from that page
  when you ask for it.
- **webRequest:** to see when a page loads an HLS playlist, and which video parts it has finished loading.
- **scripting:** to load the video from inside the page that plays it.
- **downloads:** to save the finished file.
- **storage:** to remember the videos and loaded parts found on open tabs and the details of a running download
  (session storage), and your settings.

## Chrome Web Store Limited Use

The use of information received by the extension adheres to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/),
including the Limited Use requirements. Information is used only to provide the extension's single purpose:
saving video streams that you choose to download.

## Children

The extension is not directed at children and does not knowingly handle information about children.

## Changes

If this policy changes, the new version will be published at this address with a new effective date.

## Contact

Questions about this policy: open an issue at [github.com/ekilaroglou/hls-stream-downloader/issues](https://github.com/ekilaroglou/hls-stream-downloader/issues).
