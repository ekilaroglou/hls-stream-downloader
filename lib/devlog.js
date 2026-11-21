// Developer log: what a download did, in numbers, to find out why it was slow
// or failed. It is meant to be copied and shared, so it never contains
// addresses, host names, page titles, folder or file names: hosts become
// "A", "B", …, video parts become numbers, and any such text is replaced.

const MAX_EVENTS = 1500; // kept: the first 300 and the last 1200
const SLOW_MS = 10_000;

const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
const percentile = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : null);
const ms = (v) => (v === null || v === undefined ? '–' : v >= 10_000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

export class DevLog {
  constructor() {
    this.t0 = performance.now();
    this.started = new Date();
    this.facts = new Map(); // shown at the top, in order
    this.marks = new Map(); // stage name -> seconds since start
    this.events = [];
    this.dropped = 0;
    this.hosts = new Map(); // origin -> "A", "B", …
    this.secrets = new Set(); // text that must never appear (title, folder, file and host names)
    this.requests = []; // one per attempt
  }

  seconds() {
    return (performance.now() - this.t0) / 1000;
  }

  /** Text that must never appear in the log (it is replaced by "[hidden]"). */
  hide(text) {
    const t = String(text || '').trim();
    if (t) this.secrets.add(t);
  }

  /** A short label for the server an address belongs to. The first one is the video page's site. */
  host(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return '?';
    }
    if (!this.hosts.has(u.origin)) {
      this.hosts.set(u.origin, String.fromCharCode(65 + Math.min(25, this.hosts.size)));
      this.hide(u.hostname);
    }
    return this.hosts.get(u.origin);
  }

  redact(text) {
    let t = String(text ?? '').replace(/\b(?:https?|blob|wss?):\/\/[^\s"'<>)]+/gi, (u) => `[address on host ${this.host(u)}]`);
    for (const s of [...this.secrets].sort((a, b) => b.length - a.length)) {
      if (s.length >= 4) {
        t = t.split(s).join('[hidden]');
      } else {
        // Short names ("HR", "TV") are hidden as whole words, so other words stay readable.
        const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        t = t.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'gu'), '[hidden]');
      }
    }
    return t;
  }

  fact(name, value) {
    this.facts.set(name, this.redact(value));
  }

  mark(name) {
    if (!this.marks.has(name)) this.marks.set(name, this.seconds());
  }

  event(text) {
    const line = `+${this.seconds().toFixed(2).padStart(7)}s  ${this.redact(text)}`;
    if (this.events.length >= MAX_EVENTS) {
      this.events.splice(300, 1);
      this.dropped++;
    }
    this.events.push(line);
  }

  /**
   * One request attempt: { label, url, waited, ms, status, bytes, fromCache, timing: { firstByte, total, protocol }, error }.
   * Errors, refusals and slow answers are also listed as events.
   */
  request(r) {
    const kind = /part/.test(r.label) ? 'part' : r.label;
    const host = r.url ? this.host(r.url) : '?';
    const entry = {
      kind,
      host,
      waited: r.waited || 0,
      ms: r.ms,
      status: r.status ?? null,
      bytes: r.bytes ?? null,
      cache: r.fromCache === true,
      page: r.timing?.total ?? null,
      firstByte: r.timing?.firstByte ?? null,
      protocol: r.timing?.protocol || '',
      error: r.error ? this.redact(r.error) : null,
    };
    this.requests.push(entry);
    const where = `host ${host}${entry.protocol ? `, ${entry.protocol}` : ''}`;
    // Only answers much slower than usual are listed one by one (the 5 s snapshots show the rest).
    const recent = this.requests.filter((x) => x.kind === 'part' && !x.error && x.status < 300 && !x.cache).slice(-30, -1).map((x) => x.ms);
    const usual = recent.length >= 5 ? median(recent) : 0;
    if (entry.error) this.event(`${r.label}: no answer (${entry.error}) after ${ms(r.ms)} (${where})`);
    else if (entry.status === 429 || entry.status === 503) {
      this.event(`${r.label}: HTTP ${entry.status} after ${ms(r.ms)} (${where}; ${r.retryAfter ? `Retry-After: ${r.retryAfter}` : 'no wait time the extension can read'})`);
    } else if (entry.status >= 400) this.event(`${r.label}: HTTP ${entry.status} after ${ms(r.ms)} (${where})`);
    else if (r.ms >= SLOW_MS && r.ms >= usual * 2) {
      this.event(`${r.label}: slow answer, ${ms(r.ms)} for ${entry.bytes ? mb(entry.bytes) : '?'}${usual ? ` (usually ${ms(usual)})` : ''} (${where}; first byte after ${ms(entry.firstByte)} in the page)`);
    }
  }

  summary() {
    const lines = [];
    const reqs = this.requests;
    const parts = reqs.filter((r) => r.kind === 'part');
    const good = parts.filter((r) => !r.error && r.status >= 200 && r.status < 300);
    const network = good.filter((r) => !r.cache);
    const byStatus = new Map();
    for (const r of reqs) {
      const k = r.error ? 'no answer' : r.status >= 200 && r.status < 300 ? null : `HTTP ${r.status}`;
      if (k) byStatus.set(k, (byStatus.get(k) || 0) + 1);
    }
    const kinds = new Map();
    for (const r of reqs) kinds.set(r.kind, (kinds.get(r.kind) || 0) + 1);
    lines.push(`Requests: ${reqs.length} (${[...kinds].map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`).join(', ') || 'none'})`);
    lines.push(`Problems: ${byStatus.size ? [...byStatus].map(([k, n]) => `${k} ×${n}`).join(', ') : 'none'}`);
    if (good.length) {
      lines.push(`Parts from the browser cache: ${good.length - network.length} of ${good.length}`);
      const times = network.map((r) => r.ms);
      lines.push(
        `Part requests (network): median ${ms(median(times))}, 90% under ${ms(percentile(times, 0.9))}, slowest ${ms(Math.max(0, ...times))}; ` +
          `first byte in the page median ${ms(median(network.map((r) => r.firstByte).filter((v) => v !== null)))}; ` +
          `page → extension median ${ms(median(network.filter((r) => r.page !== null).map((r) => r.ms - r.page)))}; ` +
          `waited for a free spot median ${ms(median(network.map((r) => r.waited)))}`
      );
      const bytes = good.reduce((n, r) => n + (r.bytes || 0), 0);
      const sizes = good.map((r) => r.bytes).filter(Boolean);
      lines.push(`Data: ${mb(bytes)} in parts (median part ${sizes.length ? mb(median(sizes)) : '–'})`);
      const protocols = new Map();
      for (const r of network) protocols.set(r.protocol || 'not shared by the site', (protocols.get(r.protocol || 'not shared by the site') || 0) + 1);
      lines.push(`Connection type: ${[...protocols].map(([p, n]) => `${p} ×${n}`).join(', ') || '–'}`);
    }
    lines.push(`Hosts: ${[...this.hosts.values()].join(', ') || '–'} (labels only; A is the video page's site)`);
    const stage = (name, from, to) => (this.marks.has(from) && this.marks.has(to) ? `${name} ${(this.marks.get(to) - this.marks.get(from)).toFixed(1)} s` : null);
    const stages = [
      stage('loading the playlist', 'start', 'playlist'),
      stage('downloading', 'download', 'downloaded'),
      stage('finishing the MP4', 'downloaded', 'converted'),
      stage('putting together', 'build', 'built'),
      stage('waiting for other saves', 'save-wait', 'save-start'),
      stage('writing the file', 'save-start', 'written'),
      stage('finishing the file', 'written', 'saved'),
    ].filter(Boolean);
    lines.push(`Steps: ${stages.join(' · ') || '–'}`);
    return lines;
  }

  text() {
    const out = ['HLS Stream Downloader: developer log', `Started ${this.started.toISOString().slice(0, 19).replace('T', ' ')} UTC`];
    for (const [k, v] of this.facts) out.push(`${k}: ${v}`);
    out.push('', '--- Summary', ...this.summary(), '', '--- Events (time since start)');
    const events = [...this.events];
    if (this.dropped) events.splice(300, 0, `… ${this.dropped} events left out …`);
    out.push(...events);
    return out.join('\n');
  }
}
