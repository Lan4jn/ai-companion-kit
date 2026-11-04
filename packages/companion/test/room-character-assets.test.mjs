import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const characterDir = path.resolve(__dirname, '../public/room_assets/character');
const manifestPath = path.join(characterDir, 'manifest.json');
const noticePath = path.join(characterDir, 'NOTICE.md');

test('room character manifest & asset integrity contract', async (t) => {
  await t.test('manifest.json must exist and satisfy schema specification', () => {
    assert.ok(fs.existsSync(manifestPath), `manifest.json does not exist at ${manifestPath}`);
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(raw);

    assert.equal(manifest.schema, 1, 'schema version must be 1');
    assert.equal(manifest.id, 'shenshen', 'character id must be shenshen');
    assert.deepEqual(manifest.canvas, [640, 360], 'canvas dimensions must be [640, 360]');
    assert.deepEqual(manifest.bodyBox, [212, 60, 428, 330], 'bodyBox must match [212, 60, 428, 330]');
    assert.deepEqual(manifest.anchor, [320, 330], 'anchor must be [320, 330]');

    assert.ok(manifest.clips, 'clips object must exist');
    const expectedClips = ['idle', 'move', 'sleep', 'work', 'think', 'greet'];
    assert.deepEqual(Object.keys(manifest.clips).sort(), expectedClips.sort(), 'must contain all 6 clips');

    // Loop flags
    assert.equal(manifest.clips.greet.loop, false, 'greet clip must not loop (loop: false)');
    for (const name of ['idle', 'move', 'sleep', 'work', 'think']) {
      assert.equal(manifest.clips[name].loop, true, `${name} clip must loop (loop: true)`);
    }

    // Attribution
    assert.ok(manifest.attribution, 'attribution must exist in manifest');
    assert.ok(typeof manifest.attribution.artist === 'string', 'attribution.artist must be declared');
  });

  await t.test('all media clip files (webm and poster webp) must physically exist and be non-empty', () => {
    assert.ok(fs.existsSync(manifestPath), 'manifest.json must exist to verify clips');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    for (const [clipId, clip] of Object.entries(manifest.clips)) {
      assert.ok(clip.src, `${clipId} must have src property`);
      assert.ok(clip.poster, `${clipId} must have poster property`);

      const videoFile = path.resolve(characterDir, clip.src);
      assert.ok(fs.existsSync(videoFile), `Video file for clip '${clipId}' must exist at ${videoFile}`);
      const videoStat = fs.statSync(videoFile);
      assert.ok(videoStat.size > 1024, `Video file for clip '${clipId}' too small (${videoStat.size} bytes)`);

      const posterFile = path.resolve(characterDir, clip.poster);
      assert.ok(fs.existsSync(posterFile), `Poster file for clip '${clipId}' must exist at ${posterFile}`);
      const posterStat = fs.statSync(posterFile);
      assert.ok(posterStat.size > 512, `Poster file for clip '${clipId}' too small (${posterStat.size} bytes)`);
    }
  });

  await t.test('NOTICE.md must exist and explicitly declare CC BY-NC-SA non-commercial terms', () => {
    assert.ok(fs.existsSync(noticePath), `NOTICE.md must exist at ${noticePath}`);
    const content = fs.readFileSync(noticePath, 'utf8');
    assert.ok(content.includes('PC2005-cloud/dsh-pet'), 'must credit PC2005-cloud/dsh-pet');
    assert.ok(content.includes('上善无形'), 'must credit artist 上善无形');
    assert.ok(content.includes('CC BY-NC-SA') || content.includes('非商业'), 'must state non-commercial CC terms');
    assert.ok(!content.includes('MIT License for character'), 'must not falsely claim character is MIT licensed');
  });
});
