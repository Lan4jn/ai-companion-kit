// Experimental group observation store, scoped to authenticated OneBot ingress.
// Trust root: the operator's configured local OneBot connection, not QQ signatures.
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {createManagedMemoryBrain} from './memory-brain-trust.js';
import {snapshotAuthenticatedOneBotGroupMessage} from './transport-onebot.js';

const source='qq-group-observation';
export function createGroupObservationStore({dataDir, bot, allowedGroups, account, backend='sqlite-fts'} = {}) {
 if (!path.isAbsolute(dataDir || '') || !Array.isArray(allowedGroups) || !allowedGroups.length || allowedGroups.some(x=>typeof x!=='string'||!/^[1-9]\d*$/.test(x)) || typeof account!=='string' || !/^[1-9]\d*$/.test(account) || backend!=='sqlite-fts') throw Error('invalid group observation policy');
 const groups=new Set(allowedGroups), directory=path.join(dataDir,'memory-brain-scoped');
 const file=path.join(dataDir,'group-observations.sqlite3');
 const dst=fs.lstatSync(dataDir);
 if (!dst.isDirectory() || dst.isSymbolicLink() || dst.uid!==process.getuid() || (dst.mode&0o077)) throw Error('unsafe group directory');
 if (fs.existsSync(file)) { const st=fs.lstatSync(file); if (!st.isFile() || st.isSymbolicLink() || st.uid!==process.getuid() || (st.mode&0o077) || st.nlink!==1) throw Error('unsafe observations'); }
 const db=new Database(file); fs.chmodSync(file,0o600);
 db.exec('CREATE TABLE IF NOT EXISTS observations (instance TEXT NOT NULL, account TEXT NOT NULL, gid TEXT NOT NULL, id TEXT NOT NULL, sender TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY(instance,account,gid,id))');
 const scope=gid=>Object.freeze({tenant:'companion',platform:'qq',type:'group',session:`group:${gid}`,user:`group:${gid}`});
 const store=gid=>createManagedMemoryBrain({directory,scope:scope(gid),sources:[source],trustedProcess:true,backend});
 const evidence=row=>'onebot-group:'+createHash('sha256').update(JSON.stringify([row.instance,row.account,row.groupId,row.messageId])).digest('hex');
 const insert=db.prepare('INSERT OR IGNORE INTO observations VALUES (?,?,?,?,?,?)');
 const get=db.prepare('SELECT sender,text FROM observations WHERE instance=? AND account=? AND gid=? AND id=?');
 return Object.freeze({
  async observe(msg) {
   const row=snapshotAuthenticatedOneBotGroupMessage(bot,msg);
   if (!groups.has(row.groupId) || row.account!==account) throw Error('group not authorized');
   const s=store(row.groupId), ev=evidence(row);
   return s.filterCandidates(scope(row.groupId),{candidates:[{source,evidence:ev}],onAllowed:indices=>{
    snapshotAuthenticatedOneBotGroupMessage(bot,msg);
    if (indices.length!==1) throw Error('observation forgotten');
    const old=get.get(row.instance,row.account,row.groupId,row.messageId);
    if (old && (old.sender!==row.userId || old.text!==row.text)) throw Error('observation identity conflict');
    insert.run(row.instance,row.account,row.groupId,row.messageId,row.userId,row.text);
    return ev;
   }});
  },
  // Caller must finish all uses of the text before returning; filterCandidates
  // holds the same interprocess source lock as managed forget throughout.
  async withObserved(msg, callback) {
   if (typeof callback!=='function') throw Error('callback required');
   const current=snapshotAuthenticatedOneBotGroupMessage(bot,msg);
   if (!groups.has(current.groupId) || current.account!==account) throw Error('group not authorized');
   const rows=db.prepare('SELECT instance,account,gid AS groupId,id AS messageId,sender AS userId,text FROM observations WHERE instance=? AND account=? AND gid=? ORDER BY rowid DESC LIMIT 50').all(current.instance,current.account,current.groupId).reverse();
   const s=store(current.groupId);
   if (!rows.some(r=>r.messageId===current.messageId && r.userId===current.userId && r.text===current.text)) throw Error('current observation unavailable');
   return s.filterCandidates(scope(current.groupId),{candidates:rows.map(r=>({source,evidence:evidence(r)})),onAllowed:async indices=>{
    snapshotAuthenticatedOneBotGroupMessage(bot,msg);
    const selected=indices.map(i=>Object.freeze({...rows[i]}));
    if (!selected.some(r=>r.messageId===current.messageId && r.userId===current.userId && r.text===current.text)) throw Error('current observation forgotten');
    // Capture the exact source identities used by the draft. Revalidate and hold
    // the interprocess forget lock through the network operation, not merely
    // until generation completes. Never accept identities from the model.
    const guard=async send=>s.filterCandidates(scope(current.groupId),{
     candidates:selected.map(r=>({source,evidence:evidence(r)})),
     onAllowed:approved=>{
      snapshotAuthenticatedOneBotGroupMessage(bot,msg);
      return approved.length===selected.length && new Set(approved).size===selected.length
       ? send() : {ok:false,outcome:'permanent',sent:0,error:'FORGET_DURING_DELIVERY'};
     }
    });
    return callback(selected,guard);
   }});
  },
  close(){db.close();}
 });
}
