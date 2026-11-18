import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../scripts/panel.mjs', import.meta.url), 'utf8');

test('notebook refresh invalidates changed and deleted note contents', () => {
  const fragment = source.slice(source.indexOf('const NB={'), source.indexOf('async function loadNote(it)'));
  const elements = {nbCount:{},notebook:{}};
  const c = vm.createContext({location:{hash:''},el:id=>elements[id],document:{querySelectorAll:()=>[]},loadNote:()=>{},esc:s=>String(s),Date});
  vm.runInContext(fragment + '\nthis.nb=NB;', c);
  c.renderNotebook([{path:'a.md',mtime:1,size:1,title:'a'}]);
  c.nb.cache.set('a.md', 'old contents');
  c.nb.cache.set('deleted.md', 'old deleted');
  c.renderNotebook([{path:'a.md',mtime:2,size:1,title:'a'}]);
  assert.equal(c.nb.cache.has('a.md'),false);
  assert.equal(c.nb.cache.has('deleted.md'),false);
  assert.doesNotMatch(elements.notebook.innerHTML,/old contents/);
});
