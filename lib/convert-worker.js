// Background thread of the download page: converts MPEG-TS segments to MP4
// fragments with mux.js, so the page itself stays free to receive the next
// segments. One worker per track (video, or a separate audio track); segments
// arrive and are answered in order.
self.window = self; // mux.js looks for `window`
importScripts('../vendor/mux.min.js');

let transmuxer = null;
let outputs = [];

self.onmessage = ({ data: msg }) => {
  try {
    // A discontinuity can change timestamps and settings: start a fresh converter.
    if (!transmuxer || msg.reset) {
      transmuxer = new self.muxjs.mp4.Transmuxer({ remux: true, keepOriginalTimestamps: true });
      transmuxer.on('data', (out) => outputs.push({ initSegment: out.initSegment.slice(), data: out.data.slice() }));
    }
    outputs = [];
    transmuxer.push(msg.data);
    transmuxer.flush();
    self.postMessage({ id: msg.id, outputs }, outputs.flatMap((o) => [o.initSegment.buffer, o.data.buffer]));
  } catch (e) {
    self.postMessage({ id: msg.id, error: String(e?.message || e) });
  }
};
