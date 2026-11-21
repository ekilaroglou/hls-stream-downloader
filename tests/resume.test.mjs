import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import { StreamDownload } from '../lib/download.js';
import { parsePlaylist } from '../lib/m3u8.js';

globalThis.crypto ??= webcrypto;

const originalParts = ['intro|', 'scene A|', 'scene B|', 'scene C|', 'scene D|', 'credits|'];
const segmentNames = originalParts.map((_, index) => `part-${index}.ts`);

function playlist(asset, token, names = segmentNames) {
  const url = `https://media.example/${asset}/playlist.m3u8?token=${token}`;
  const segments = names.map((name) => `#EXTINF:4,\n${name}?token=${token}`);
  return parsePlaylist(['#EXTM3U', '#EXT-X-TARGETDURATION:4', ...segments, '#EXT-X-ENDLIST'].join('\n'), url);
}

// A missing response pauses the real download engine with its ordered prefix intact.
function fixtureFetch(media, parts) {
  const responses = new Map(parts.map((part, index) => [media.segments[index].url, part]));
  return async (url) => responses.has(url)
    ? new Response(responses.get(url))
    : new Response(null, { status: 404 });
}

async function pauseAfter(count) {
  const media = playlist('movie-A', 'old');
  const job = new StreamDownload({ media }, { speed: Infinity, connections: 1, keepOriginal: true });
  await assert.rejects(job.run({ fetchImpl: fixtureFetch(media, originalParts.slice(0, count)) }), { status: 404 });
  assert.equal(job.done, count);
  return job;
}

test('one saved intro cannot authorize resuming a different video', async () => {
  const job = await pauseAfter(1);
  const other = playlist('movie-B', 'new');
  const fetchImpl = fixtureFetch(other, [originalParts[0], 'other footage|']);
  assert.equal(await job.isSameVideo(other, { fetchImpl }), false);
  assert.equal(job.done, 1);
});

// Resume checks a sample of the kept parts (the last one, where the download goes on, the first and a
// middle one), not every kept part: checking all of them would download the kept part of the video a
// second time on every resume, which is slow and can run into a site's request limits.
test('rejects a renewed link whose last kept part has different content', async () => {
  const job = await pauseAfter(5);
  const renewed = playlist('movie-A', 'new');
  const changedParts = [...originalParts];
  changedParts[4] = 'different scene|';
  assert.equal(await job.isSameVideo(renewed, { fetchImpl: fixtureFetch(renewed, changedParts) }), false);
  assert.equal(job.done, 5);
});

test('verifying a resume requests only a few kept parts', async () => {
  const job = await pauseAfter(5);
  const renewed = playlist('movie-A', 'new');
  const requested = [];
  const fetchImpl = (url) => {
    requested.push(url);
    return fixtureFetch(renewed, originalParts)(url);
  };
  assert.equal(await job.isSameVideo(renewed, { fetchImpl }), true);
  assert.ok(requested.length <= 3, `${requested.length} requests`);
});

test('rejects a playlist whose remaining segment addresses identify a different cut', async () => {
  const job = await pauseAfter(1);
  const names = [segmentNames[0], ...segmentNames.slice(1).map((name) => `alternate/${name}`)];
  const other = playlist('movie-A', 'new', names);
  assert.equal(await job.isSameVideo(other, { fetchImpl: fixtureFetch(other, originalParts) }), false);
});

test('a signed renewal resumes at the missing part and preserves the original bytes', async () => {
  const job = await pauseAfter(5);
  const renewed = playlist('movie-A', 'new');
  const fetchImpl = fixtureFetch(renewed, originalParts);
  assert.equal(await job.isSameVideo(renewed, { fetchImpl }), true);
  job.replaceMedia({ media: renewed });
  const requested = [];
  const resumeFetch = (url) => {
    requested.push(url);
    return fetchImpl(url);
  };
  await job.run({ fetchImpl: resumeFetch });
  assert.deepEqual(requested, [renewed.segments[5].url]);
  assert.equal(await job.finish().files[0].blob.text(), originalParts.join(''));
});

// "Save loaded part" makes no requests to verify: it waits until the page has played the last
// collected part again (the player may not play earlier parts again if it resumes later on).
test('loaded-part verification waits for the last collected part, without requests', async () => {
  const media = playlist('movie-A', 'old');
  const job = new StreamDownload({ media }, { speed: Infinity, connections: 1 });
  await job.collect({
    fetchImpl: fixtureFetch(media, originalParts),
    isLoaded: (seg) => seg === media.segments[1] || seg === media.segments[4],
  });
  assert.equal(job.collectedCount, 2);
  const renewed = playlist('movie-A', 'new');
  assert.equal(await job.isSameVideo(renewed, {
    mayRequest: false,
    isLoaded: (seg) => seg.url === renewed.segments[1].url,
    fetchImpl: () => assert.fail('nothing may be requested before the last collected part is played again'),
  }), false);
  const fromCache = [];
  assert.equal(await job.isSameVideo(renewed, {
    mayRequest: false,
    isLoaded: (seg) => seg.url === renewed.segments[4].url,
    fetchImpl: (url, init) => {
      fromCache.push(init?.cache);
      return fixtureFetch(renewed, originalParts)(url);
    },
  }), true);
  assert.deepEqual(fromCache, ['force-cache']);
});

test('a changed separate audio playlist cannot be substituted on resume', async () => {
  const media = playlist('movie-A', 'old');
  const audioMedia = playlist('english', 'old');
  const job = new StreamDownload({ media, audioMedia }, { speed: Infinity, connections: 1 });
  const renewed = playlist('movie-A', 'new');
  const otherAudio = playlist('commentary', 'new');
  assert.equal(await job.isSameVideo(renewed, {
    audioMedia: otherAudio,
    fetchImpl: fixtureFetch(renewed, originalParts),
  }), false);
  assert.throws(() => job.replaceMedia({ media: renewed, audioMedia: otherAudio }));
});
