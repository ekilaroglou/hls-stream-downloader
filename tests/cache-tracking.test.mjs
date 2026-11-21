import assert from 'node:assert/strict';
import test from 'node:test';
import { StreamDownload } from '../lib/download.js';
import { requestId } from '../lib/loaded.js';
import { parsePlaylist } from '../lib/m3u8.js';

const tabId = 7;
const key = 'loaded:7';
const url = 'https://example.invalid/segment.ts';
const range = 'bytes=0-99';
const otherRange = 'bytes=100-199';
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
let workerId = 0;

// Import a fresh service worker for each start, preserving only session storage.
async function startWorker(session) {
  const events = {};
  const event = (name) => ({ addListener: (fn) => { events[name] = fn; } });
  globalThis.chrome = {
    runtime: { id: 'test', onMessage: event('message') },
    tabs: { onCreated: event('created'), onRemoved: event('removed') },
    webRequest: {
      onSendHeaders: event('send'), onCompleted: event('complete'), onErrorOccurred: event('error'),
      onBeforeRequest: event('before'), onHeadersReceived: event('headers'),
    },
    storage: { session },
  };
  await import(`../background.js?worker=${++workerId}`);

  function response({ headers = [], requestedRange = range, redirect } = {}) {
    const request = { tabId, requestId: 'request', type: 'xmlhttprequest', url };
    const requestHeaders = [{ name: 'Range', value: requestedRange }];
    events.send({ ...request, requestHeaders });
    if (redirect) events.send({ ...request, url: redirect, requestHeaders });
    events.complete({ ...request, url: redirect ?? url, statusCode: 206, responseHeaders: headers });
  }
  async function flushAdditions() {
    await nextTurn();
    await new Promise((resolve) => setTimeout(resolve, 550));
  }
  return { response, flushAdditions };
}

function sessionStorage() {
  const data = {};
  return {
    data,
    async get(name) { return name ? { [name]: data[name] } : { ...data }; },
    async set(entries) { Object.assign(data, entries); },
  };
}

test('revokes persisted no-store and Vary:* ranges on the original and redirected URL', async () => {
  const session = sessionStorage();
  const cdn = 'https://cdn.example.invalid/asset.ts';
  const first = await startWorker(session);
  first.response({ redirect: cdn });
  first.response({ redirect: cdn, requestedRange: otherRange });
  await first.flushAdditions();
  assert.deepEqual(new Set(session.data[key]), new Set([
    requestId(url, range), requestId(cdn, range), requestId(url, otherRange), requestId(cdn, otherRange),
  ]));

  const restarted = await startWorker(session);
  restarted.response({ redirect: cdn, headers: [{ name: 'Cache-Control', value: 'private, no-store' }] });
  await nextTurn();
  assert.deepEqual(new Set(session.data[key]), new Set([requestId(url, otherRange), requestId(cdn, otherRange)]));

  restarted.response({ redirect: cdn, requestedRange: otherRange, headers: [
    { name: 'Vary', value: 'Accept' }, { name: 'Vary', value: '*' },
  ] });
  await nextTurn();
  assert.equal(session.data[key].length, 0);

  restarted.response({ redirect: cdn });
  await restarted.flushAdditions();
  assert.deepEqual(new Set(session.data[key]), new Set([requestId(url, range), requestId(cdn, range)]));
});

test('a delayed older write cannot resurrect a revoked segment', async () => {
  const session = sessionStorage();
  const store = session.set;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  session.set = async (entries) => {
    if (entries[key].length) await blocked;
    await store(entries);
  };
  const worker = await startWorker(session);
  worker.response();
  await worker.flushAdditions();
  worker.response({ headers: [{ name: 'Cache-Control', value: 'no-store' }] });
  await nextTurn();
  release();
  await nextTurn();
  assert.equal(session.data[key].length, 0);
});

test('collection skips segments revoked in the queue or while fetching their initialization data', async () => {
  const media = parsePlaylist([
    '#EXTM3U', '#EXT-X-TARGETDURATION:4', '#EXTINF:4,', 'kept.ts',
    '#EXT-X-MAP:URI="init.mp4"', '#EXTINF:4,', 'revoked.m4s',
    '#EXT-X-MAP:URI="unused.mp4"', '#EXTINF:4,', 'queued.m4s', '#EXT-X-ENDLIST',
  ].join('\n'), 'https://example.invalid/test.m3u8');
  const [kept, revoked, queued] = media.segments;
  const eligible = new Set(media.segments);
  const job = new StreamDownload({ media }, { connections: 1, speed: Infinity });
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    if (url === revoked.map.url) {
      eligible.delete(revoked);
      eligible.delete(queued);
    }
    return new Response(new Uint8Array(4));
  };
  const result = await job.collect({ fetchImpl, isLoaded: (seg) => eligible.has(seg) });
  assert.deepEqual(requested, [kept.url, revoked.map.url]);
  assert.equal(result, 1);
  assert.equal(job.collectedCount, 1);
});
