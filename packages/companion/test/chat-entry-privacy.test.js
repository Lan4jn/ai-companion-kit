import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('outbound generation does not load provenance-free owner profile or all-group chatter',()=>{
 const bili=fs.readFileSync(new URL('../src/bili-living.js',import.meta.url),'utf8');
 const index=fs.readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
 assert.doesNotMatch(bili,/ctx\.memory\.renderPerson\(String\(ctx\.ownerQQ\)\)/);
 assert.doesNotMatch(index,/renderGroupChatter\(null/);
});
