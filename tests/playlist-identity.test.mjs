import assert from 'node:assert/strict';
import test from 'node:test';
import { countVideos, streamKey } from '../lib/streams.js';

test('master and quality playlists keep distinct IDs on a shared endpoint', () => {
  for (const [masterId, qualityId] of [
    ['movie', 'rendition'],
    ['1234567890', '1234567891'],
    ['a'.repeat(42), 'b'.repeat(42)],
  ]) {
    const url = 'https://media.example/playlist?id=' + masterId;
    const quality = 'https://media.example/playlist?id=' + qualityId;
    const master = { url, key: streamKey(url), text: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=9000\n' + quality };
    assert.notEqual(master.key, streamKey(quality));
    assert.equal(countVideos([master, { url: quality, key: streamKey(quality) }]), 1);
  }
});

test('renewed signatures keep the playlist identity', () => {
  const before = 'https://media.example/playlist?id=1234567890&sig=old&expires=1800000000';
  const after = 'https://media.example/playlist?expires=1900000000&sig=new&id=1234567890';
  assert.equal(streamKey(before), streamKey(after));
});

test('ambiguous query fields can select distinct content, even on signed links', () => {
  for (const name of ['author', 'e', 't', 'hash']) {
    const endpoint = 'https://media.example/watch?sig=example&' + name + '=';
    assert.notEqual(streamKey(endpoint + '1'), streamKey(endpoint + '2'));
  }
});
