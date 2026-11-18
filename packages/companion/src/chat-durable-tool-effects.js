// Isolated, opt-in tool-effect executor. Use a dedicated EncryptedChatJournal.
// Not wired to handleTurn: caller must provide stable turn/call identities and
// trusted tool implementations. Unknown outcomes are deliberately irreversible.
import {EncryptedChatJournal} from './chat-durable-journal-candidate.js';

function data(value) {
  const seen=new Set();
  function check(v) {
    if (v===null || typeof v==='string' || typeof v==='boolean') return;
    if (typeof v==='number' && Number.isFinite(v) && !Object.is(v,-0)) return;
    if (!v || typeof v!=='object' || seen.has(v)) throw Error('JSON data required');
    seen.add(v);
    if (Array.isArray(v)) {
      if (Reflect.ownKeys(v).length!==v.length+1) throw Error('JSON data required');
      for (let i=0;i<v.length;i++) { const d=Object.getOwnPropertyDescriptor(v,String(i)); if(!d || !('value' in d)) throw Error('JSON data required'); check(d.value); }
    } else {
      if (Object.getPrototypeOf(v)!==Object.prototype && Object.getPrototypeOf(v)!==null) throw Error('JSON data required');
      for (const k of Reflect.ownKeys(v)) { const d=Object.getOwnPropertyDescriptor(v,k); if(typeof k!=='string' || !d.enumerable || !('value' in d)) throw Error('JSON data required'); check(d.value); }
    }
    seen.delete(v);
  }
  check(value);
  const encoded=JSON.stringify(value);
  if (Buffer.byteLength(encoded)>65536) throw Error('data too large');
  return JSON.parse(encoded);
}
const validId = x => typeof x==='string' && x.length>0 && Buffer.byteLength(x)<=512;

export function createDurableToolEffects({enabled=false,journal,tools}={}) {
  if (enabled!==true) throw Error('tool effects disabled');
  if (!(journal instanceof EncryptedChatJournal) || !tools || typeof tools!=='object') throw Error('journal and tools required');
  // Capture the trusted registry once; never select executable code from input.
  const registry=new Map(Object.entries(tools));
  if ([...registry].some(([name,fn])=>!validId(name) || typeof fn!=='function')) throw Error('invalid tools');
  function validate() {
    journal.checkLock(); const keys=new Set();
    for (const r of journal.rows) {
      if (!r || r.kind!=='tool-effect-v1' || !validId(r.session) || !validId(r.turn) || !validId(r.call) || !validId(r.tool) || !['unknown','completed'].includes(r.state) || !Object.hasOwn(r,'args') || (r.state==='completed' && !Object.hasOwn(r,'result')) || (r.state==='unknown' && Object.hasOwn(r,'result'))) throw Error('invalid tool journal');
      data(r.args); if(r.state==='completed') data(r.result);
      const key=JSON.stringify([r.session,r.turn,r.call]); if(keys.has(key)) throw Error('duplicate tool identity'); keys.add(key);
    }
  }
  validate();
  return Object.freeze({
    async execute(request) {
      if (!request || !validId(request.session) || !validId(request.turn) || !validId(request.call) || !validId(request.tool)) throw Error('invalid tool request');
      const {session,turn,call,tool}=request; const args=data(request.args);
      validate();
      const previous=journal.rows.find(r=>r.session===session && r.turn===turn && r.call===call);
      if (previous && (previous.tool!==tool || JSON.stringify(previous.args)!==JSON.stringify(args))) throw Error('tool identity mismatch');
      // Even a completed earlier call must not unblock further work after unknown.
      if (journal.rows.some(r=>r.session===session && r.state==='unknown')) throw Error('session blocked by unknown tool effect');
      if (previous) return data(previous.result);
      const fn=registry.get(tool); if (!fn) throw Error('tool not allowed');
      const row={kind:'tool-effect-v1',session,turn,call,tool,args,state:'unknown'};
      journal.save([...journal.rows,row]);
      // Any throw, invalid result, process loss or persistence error keeps unknown.
      const outcome=await fn(data(args));
      if (!outcome || outcome.status!=='completed' || !Object.hasOwn(outcome,'result')) throw Error('tool outcome unknown');
      const result=data(outcome.result);
      validate();
      const rows=structuredClone(journal.rows);
      const current=rows.find(r=>r.session===session && r.turn===turn && r.call===call);
      if (!current || current.state!=='unknown' || current.tool!==tool || JSON.stringify(current.args)!==JSON.stringify(args)) throw Error('tool claim changed');
      current.state='completed'; current.result=result;
      journal.save(rows);
      return data(result);
    }
  });
}
