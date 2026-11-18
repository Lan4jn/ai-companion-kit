"""Optional stdlib SQLite FTS worker; not AME. Caller authenticates and authorizes every request."""
import fcntl, hashlib, json, os, re, sqlite3, stat, sys, time, uuid
from urllib.parse import quote

os.umask(0o077)
r = json.load(sys.stdin)
op = r['operation']
readonly = op in ('privateHistory', 'inspectChatHistoryReservations')
items = r['scopes'] if op in ('rankCandidates', 'filterCandidates') else [r]
locks = []
dbs = {}
def digest(x): return hashlib.sha256(x.encode()).hexdigest()
def question_fragments(query):
    # Conservative question scaffolding, not a dictionary or semantic inference.
    # Require a question marker and a >=4 Han character contiguous literal.
    if len(query) > 256 or not re.search(r'[?？]|什么|哪些|哪部|哪个|多少|怎么|如何|吗|呢', query):
        return []
    parts = re.split(r'什么|哪些|哪部|哪个|多少|怎么|如何|请问|最近|喜欢|记得|知道|关于|我们|你|我|的|是|吗|呢|[\W_]+', query)
    return list(dict.fromkeys(p for p in parts if re.fullmatch(r'[\u3400-\u4dbf\u4e00-\u9fff]{4,32}', p)))[:8]

def ranked(records, query, limit):
    # Avoid unbounded FTS parser inputs and huge repeated substring scans.
    if len(query) > 256:
        return []
    engine = sqlite3.connect(':memory:')
    try:
        engine.execute("CREATE VIRTUAL TABLE fts USING fts5(content, tokenize='unicode61')")
        engine.executemany('INSERT INTO fts(rowid,content) VALUES (?,?)', [(i+1, r['text']) for i,r in enumerate(records)])
        tokens = re.findall(r'[^\W_]+', query, flags=re.UNICODE)[:32]
        expression = ' OR '.join('"' + token.replace('"', '""') + '"' for token in tokens)
        matches = [records[row[0]-1] for row in engine.execute('SELECT rowid FROM fts WHERE fts MATCH ? ORDER BY rank LIMIT ?', (expression, limit))] if expression else []
        spans = re.findall(r'[\u3400-\u4dbf\u4e00-\u9fff]{2,}', query)
        exact = [record for record in records if any(span in record['text'] for span in spans)]
        fragments = question_fragments(query)
        partial = [record for record in records if any(part in record['text'] for part in fragments)]
        seen = set()
        ordered = []
        for record in exact + matches + partial:
            if id(record) not in seen:
                seen.add(id(record)); ordered.append(record)
        return ordered[:limit]
    finally: engine.close()

def connect(item):
    path = item['path']
    lock = os.open(path + '.lock', (os.O_RDONLY if readonly else os.O_CREAT | os.O_RDWR) | os.O_NOFOLLOW, 0o600)
    st = os.fstat(lock)
    if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077 or st.st_nlink != 1: raise ValueError('unsafe lock')
    fcntl.flock(lock, fcntl.LOCK_SH if readonly else fcntl.LOCK_EX)
    locks.append(lock)
    if op == 'migrateLegacyEvidence':
        current=os.stat(path,follow_symlinks=False)
        if (current.st_dev,current.st_ino)!=(ts.st_dev,ts.st_ino): raise ValueError('target replaced')
        with open(path,'rb') as f: current_hash=hashlib.sha256(f.read()).hexdigest()
        if current_hash!=target_hash: raise ValueError('target changed')
    if os.path.lexists(path + '.revoked') and op != 'revoke': raise ValueError('revoked')
    if readonly:
        if op == 'inspectChatHistoryReservations' and any(os.path.lexists(path + suffix) for suffix in ('-wal','-shm','-journal')): raise ValueError('unfinished sqlite state')
        if os.path.lexists(path + '-wal') and not os.path.isfile(path + '-shm'): raise ValueError('WAL unavailable')
        suffix = '?mode=ro' if os.path.lexists(path + '-wal') else '?mode=ro&immutable=1'
        db = sqlite3.connect('file:' + quote(path, safe='/') + suffix, uri=True)
    else:
        db = sqlite3.connect(path, timeout=10)
        if op == 'migrateLegacyEvidence':
            current=os.stat(path,follow_symlinks=False)
            if (current.st_dev,current.st_ino)!=(ts.st_dev,ts.st_ino):
                db.close(); raise ValueError('target replaced during open')
    db.row_factory = sqlite3.Row
    tables = {x[0] for x in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
    if tables and 'local_identity' not in tables: raise ValueError('incompatible database; no migration')
    identity = json.dumps([item['scope'], item['source']], ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    if op == 'migrateLegacyEvidence':
        return db
    if not tables:
        if readonly: raise ValueError('uninitialized database')
        db.executescript('''CREATE TABLE local_identity (identity TEXT NOT NULL, retention INTEGER NOT NULL, revoked INTEGER NOT NULL);
        CREATE TABLE local_entries (id TEXT PRIMARY KEY, evidence TEXT UNIQUE NOT NULL, text TEXT NOT NULL, created REAL NOT NULL);
        CREATE TABLE local_tombstones (digest TEXT PRIMARY KEY);
        CREATE TABLE local_turns (turn_hash TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, body TEXT);
        CREATE TABLE local_events (event_hash TEXT PRIMARY KEY, turn_hash TEXT NOT NULL);''')
        db.execute('INSERT INTO local_identity VALUES (?,?,0)',(identity,item['retentionMs']))
        db.commit()
    row = db.execute('SELECT * FROM local_identity').fetchall()
    if len(row)!=1 or row[0]['identity'] != identity or row[0]['revoked']: raise ValueError('identity mismatch or revoked')
    if any(not isinstance(x[0], str) or not re.fullmatch(r'[a-f0-9]{64}', x[0]) for x in db.execute('SELECT digest FROM local_tombstones')): raise ValueError('invalid tombstone')
    if not readonly:
        db.execute('CREATE TABLE IF NOT EXISTS local_history_reservations (turn_hash TEXT PRIMARY KEY, payload_hash TEXT NOT NULL)')
        db.execute('PRAGMA secure_delete=ON')
        db.execute('UPDATE local_identity SET retention=MIN(retention,?)',(item['retentionMs'],))
        db.commit()
    return db

def forgotten(db, evidence): return bool(db.execute('SELECT 1 FROM local_tombstones WHERE digest=?',(digest(evidence),)).fetchone())
def records(db, item):
    retention = min(item['retentionMs'], db.execute('SELECT retention FROM local_identity').fetchone()[0])
    return [{'id':row['id'], 'text':row['text'], 'source':item['source'], 'evidence':row['evidence'], 'created_at':row['created']} for row in db.execute('SELECT * FROM local_entries WHERE created>? ORDER BY created DESC,rowid DESC',(time.time()-retention/1000,)) if not forgotten(db,row['evidence'])]

source_guard = None
try:
    if op == 'migrateLegacyEvidence':
        guard=r['sourceGuard']; source_path=guard['path']
        # Only a durable, unconsumed, operator-confirmed attempt is admissible.
        # Local same-uid processes can alter both this code and the ledger: they
        # are the trust root, not an adversarial security boundary.
        token=r['authorization']; directory=os.path.dirname(r['path'])
        if not re.fullmatch(r'[a-f0-9]{32}', token): raise ValueError('invalid authorization')
        ledger_path=os.path.join(directory,'offline-migration-audit.sqlite3')
        st=os.lstat(ledger_path)
        if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or st.st_mode & 0o077 or st.st_nlink!=1: raise ValueError('unsafe audit')
        ledger=sqlite3.connect('file:'+quote(ledger_path,safe='/')+'?mode=rw',uri=True,timeout=0)
        ledger.execute('PRAGMA synchronous=FULL')
        ledger.execute('BEGIN IMMEDIATE')
        ledger.row_factory=sqlite3.Row
        attempt=ledger.execute('SELECT * FROM attempts WHERE authorization=?',(token,)).fetchone()
        js=lambda x: json.dumps(x,ensure_ascii=False,separators=(',',':'))
        ev=r['record']['evidence']
        if not attempt or attempt['status']!='attempt' or time.time()>attempt['expires'] or attempt['issued']>time.time() or attempt['event_key']!=digest(js([r['scope'],r['source'],ev])) or attempt['scope_hash']!=digest(js(r['scope'])) or attempt['source_hash']!=digest(r['source']) or attempt['event_hash']!=digest(ev) or attempt['source_digest']!=guard['digest']: raise ValueError('authorization missing, expired, consumed or mismatched')
        stem=digest(js([r['scope'],r['source']]))
        if source_path!=os.path.join(directory,stem+'.sqlite3') or r['path']!=os.path.join(directory,'sqlite-fts-v1-'+stem+'.sqlite3'): raise ValueError('source or target path mismatch')
        target=r['path']; ts=os.lstat(target)
        if not stat.S_ISREG(ts.st_mode) or ts.st_uid!=os.getuid() or ts.st_mode & 0o077 or ts.st_nlink!=1: raise ValueError('unsafe target')
        with open(target,'rb') as f: target_hash=hashlib.sha256(f.read()).hexdigest()
        if (attempt['target_digest']=='absent' and ts.st_size!=0) or (attempt['target_digest']!='absent' and target_hash!=attempt['target_digest']): raise ValueError('target changed')
        # Consume before target writes; a crash leaves an unreplayable unknown.
        if ledger.execute("UPDATE attempts SET status='consumed' WHERE authorization=? AND status='attempt'",(token,)).rowcount!=1: raise ValueError('authorization consumed')
        ledger.commit(); ledger.close()
        source_fd=os.open(source_path,os.O_RDONLY|os.O_NOFOLLOW)
        def check_source():
            for suffix in ('-wal','-shm','-journal','.revoked'):
                if os.path.lexists(source_path+suffix): raise ValueError('source sidecar or revocation present')
            st=os.fstat(source_fd); current=os.stat(source_path,follow_symlinks=False)
            if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or st.st_mode & 0o077 or st.st_nlink!=1 or (st.st_dev,st.st_ino)!=(current.st_dev,current.st_ino): raise ValueError('unsafe or replaced source')
            os.lseek(source_fd,0,os.SEEK_SET); h=hashlib.sha256()
            while True:
                b=os.read(source_fd,1024*1024)
                if not b: break
                h.update(b)
            if h.hexdigest()!=guard['digest']: raise ValueError('source changed during handoff')
        check_source()
        source_guard=sqlite3.connect('file:'+quote(source_path,safe='/')+'?mode=rw',uri=True,timeout=0)
        source_guard.execute('BEGIN IMMEDIATE')
        check_source()
        rec=r['record']
        policy=source_guard.execute('SELECT revoked FROM adapter_policy WHERE id=1').fetchone()
        retention=source_guard.execute('SELECT retention_ms FROM adapter_retention WHERE id=1').fetchone()
        if (policy and policy[0]!=0) or not retention or type(retention[0])!=int or retention[0]<r['retentionMs'] or source_guard.execute('SELECT 1 FROM adapter_forget_tombstones WHERE evidence_hash=?',(digest(ev),)).fetchone(): raise ValueError('source policy denies migration')
        rows=source_guard.execute("SELECT text,source,meta,created_at FROM memories WHERE status='active' AND visibility='private' AND json_valid(meta) AND json_extract(meta,'$.evidence')=? LIMIT 2",(ev,)).fetchall()
        if len(rows)!=1: raise ValueError('source event missing or ambiguous')
        text,source,meta,created=rows[0]; meta=json.loads(meta)
        if source!=r['source'] or meta.get('adapter_version')!=1 or meta.get('scope')!=r['scope'] or rec.get('scope')!=r['scope'] or rec.get('source')!=source or text!=rec.get('text') or created!=rec.get('created_at') or not isinstance(text,str) or not text.strip() or len(text)>512 or isinstance(created,bool) or not isinstance(created,(int,float)) or not time.time()-r['retentionMs']/1000<created<=time.time(): raise ValueError('source evidence mismatch')
    for item in items: dbs[item['source']] = connect(item)
    if op in ('rankCandidates','filterCandidates'):
        candidates = [x for x in r['candidates'] if not forgotten(dbs[x['source']],x['evidence'])]
        if op == 'filterCandidates': result = [i for i,x in enumerate(r['candidates']) if not forgotten(dbs[x['source']],x['evidence'])]
        else: result = ranked(candidates,r['query'],r['limit'])
    else:
        db=dbs[r['source']]
        if op == 'remember':
            rec=r['record']; ev=rec['evidence']
            if forgotten(db,ev): raise ValueError('forgotten')
            old=db.execute('SELECT * FROM local_entries WHERE evidence=?',(ev,)).fetchone()
            if old and old['text'] != rec['text']: raise ValueError('conflict')
            result=old['id'] if old else uuid.uuid4().hex
            if not old: db.execute('INSERT INTO local_entries VALUES (?,?,?,?)',(result,ev,rec['text'],time.time()))
        elif op == 'migrateLegacyEvidence':
            rec=r['record']; ev=rec['evidence']
            db.execute('BEGIN IMMEDIATE')
            tables={row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
            if not tables:
                for sql in ('CREATE TABLE local_identity (identity TEXT NOT NULL, retention INTEGER NOT NULL, revoked INTEGER NOT NULL)',
                            'CREATE TABLE local_entries (id TEXT PRIMARY KEY, evidence TEXT UNIQUE NOT NULL, text TEXT NOT NULL, created REAL NOT NULL)',
                            'CREATE TABLE local_tombstones (digest TEXT PRIMARY KEY)',
                            'CREATE TABLE local_turns (turn_hash TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, body TEXT)',
                            'CREATE TABLE local_events (event_hash TEXT PRIMARY KEY, turn_hash TEXT NOT NULL)',
                            'CREATE TABLE local_history_reservations (turn_hash TEXT PRIMARY KEY, payload_hash TEXT NOT NULL)'):
                    db.execute(sql)
                identity=json.dumps([r['scope'],r['source']],ensure_ascii=False,sort_keys=True,separators=(',', ':'))
                db.execute('INSERT INTO local_identity VALUES (?,?,0)',(identity,r['retentionMs']))
            # Re-read authorization under the same SQLite write transaction as
            # the tombstone lookup and insertion; file locks are only advisory.
            identity=json.dumps([r['scope'],r['source']],ensure_ascii=False,sort_keys=True,separators=(',', ':'))
            rows=db.execute('SELECT identity,retention,revoked FROM local_identity').fetchall()
            if len(rows)!=1 or rows[0]['identity']!=identity or rows[0]['revoked']!=0 or type(rows[0]['retention'])!=int or rows[0]['retention']<r['retentionMs']: raise ValueError('identity, revocation or retention changed')
            if forgotten(db,ev): result={'status':'forgotten'}
            else:
                old=db.execute('SELECT * FROM local_entries WHERE evidence=?',(ev,)).fetchone()
                if old and (old['text'] != rec['text'] or old['created'] != rec['created_at']): raise ValueError('migration conflict')
                if old: result={'status':'duplicate'}
                else:
                    db.execute('INSERT INTO local_entries VALUES (?,?,?,?)',(uuid.uuid4().hex,ev,rec['text'],rec['created_at']))
                    result={'status':'inserted'}
        elif op == 'recall': result=ranked(records(db,r),r['query'],r['limit'])
        elif op == 'evidenceRecords':
            wanted=set(r['evidence'])
            result=[x for x in records(db,r) if x['evidence'] in wanted]
        elif op == 'inspectChatHistoryReservations':
            rows=db.execute('SELECT turn_hash,payload_hash FROM local_history_reservations ORDER BY turn_hash').fetchall()
            if any(not isinstance(v,str) or not re.fullmatch(r'[a-f0-9]{64}',v) for row in rows for v in row): raise ValueError('invalid reservation')
            result={'reservations':[{'turnHash':row['turn_hash'],'payloadHash':row['payload_hash'],'delivery':'unverified'} for row in rows]}
        elif op == 'privateHistory':
            import re
            result=list(reversed([{'text':x['text'],'source':x['source'],'evidence':x['evidence'],'created_at':x['created_at']} for x in records(db,r) if re.fullmatch(r'onebot-message:(?:0|-?[1-9][0-9]*)',x['evidence'])][:r['limit']]))
        elif op == 'cleanup':
            retention=db.execute('SELECT retention FROM local_identity').fetchone()[0]
            result=db.execute('DELETE FROM local_entries WHERE created<=?',(time.time()-retention/1000,)).rowcount
        elif op == 'requireChatHistoryCapacity':
            result=db.execute('SELECT (SELECT COUNT(*) FROM local_turns)+(SELECT COUNT(*) FROM local_history_reservations)').fetchone()[0] < r['maxChatHistoryTurns']
        elif op == 'reserveChatHistory':
            turn=r['turn']; th=digest(turn['turnId']); ph=digest(json.dumps(turn,ensure_ascii=False,separators=(',',':')))
            db.execute('BEGIN IMMEDIATE')
            old=db.execute('SELECT * FROM local_turns WHERE turn_hash=?',(th,)).fetchone()
            reservation=db.execute('SELECT payload_hash FROM local_history_reservations WHERE turn_hash=?',(th,)).fetchone()
            if any(forgotten(db,e) for e in turn['events']) or (old and old['body'] is None): raise ValueError('forgotten')
            if old:
                if old['payload_hash'] != ph: raise ValueError('turn conflict')
                raise ValueError('turn already committed')
            if reservation:
                if reservation['payload_hash'] != ph: raise ValueError('reservation conflict')
            else:
                used=db.execute('SELECT (SELECT COUNT(*) FROM local_turns)+(SELECT COUNT(*) FROM local_history_reservations)').fetchone()[0]
                if used >= r['maxChatHistoryTurns']: raise ValueError('chat history capacity')
                db.execute('INSERT INTO local_history_reservations VALUES (?,?)',(th,ph))
            result='reserved'
        elif op == 'commitChatHistory':
            turn=r['turn']; th=digest(turn['turnId']); hashes=[digest(e) for e in turn['events']]
            body=json.dumps(turn,ensure_ascii=False,separators=(',',':')); ph=digest(body)
            db.execute('BEGIN IMMEDIATE')
            old=db.execute('SELECT * FROM local_turns WHERE turn_hash=?',(th,)).fetchone()
            reservation=db.execute('SELECT payload_hash FROM local_history_reservations WHERE turn_hash=?',(th,)).fetchone()
            if reservation and reservation['payload_hash'] != ph: raise ValueError('reservation conflict')
            external_forgotten=r.get('externalForgotten',[])
            if not isinstance(external_forgotten,list) or any(e not in turn['events'] for e in external_forgotten): raise ValueError('invalid external tombstones')
            if external_forgotten or any(forgotten(db,e) for e in turn['events']) or (old and old['body'] is None):
                db.execute('DELETE FROM local_history_reservations WHERE turn_hash=?',(th,)); result='forgotten'
            elif old:
                if old['payload_hash'] != ph: raise ValueError('turn conflict')
                result='duplicate'
            else:
                used=db.execute('SELECT (SELECT COUNT(*) FROM local_turns)+(SELECT COUNT(*) FROM local_history_reservations)').fetchone()[0]
                if not reservation and used >= r['maxChatHistoryTurns']: raise ValueError('chat history capacity')
                db.execute('INSERT INTO local_turns VALUES (?,?,?)',(th,ph,body))
                db.execute('DELETE FROM local_history_reservations WHERE turn_hash=?',(th,))
                db.executemany('INSERT INTO local_events VALUES (?,?)',[(h,th) for h in hashes]); result='inserted'
        elif op == 'chatHistory': result=[json.loads(row[0]) for row in reversed(db.execute('SELECT body FROM local_turns WHERE body IS NOT NULL ORDER BY rowid DESC LIMIT ?',(r['limit'],)).fetchall())]
        elif op == 'forget':
            db.execute('BEGIN IMMEDIATE')
            h=digest(r['evidence'])
            if r.get('exactSingle'):
                linked=db.execute('SELECT turn_hash FROM local_events WHERE event_hash=?',(h,)).fetchall()
                if linked:
                    count=db.execute('SELECT COUNT(*) FROM local_events WHERE turn_hash=?',(linked[0][0],)).fetchone()[0]
                    if len(linked)!=1 or count!=1: raise ValueError('ambiguous merged turn')
                entries=db.execute('SELECT COUNT(*) FROM local_entries WHERE evidence=?',(r['evidence'],)).fetchone()[0]
                turns=db.execute('SELECT COUNT(*) FROM local_turns WHERE body IS NOT NULL AND turn_hash IN (SELECT turn_hash FROM local_events WHERE event_hash=?)',(h,)).fetchone()[0]
                if entries+turns!=1: raise ValueError('missing or ambiguous exact target')
            db.execute('INSERT OR IGNORE INTO local_tombstones VALUES (?)',(h,))
            db.execute('UPDATE local_turns SET body=NULL WHERE turn_hash IN (SELECT turn_hash FROM local_events WHERE event_hash=?)',(h,))
            result=db.execute('DELETE FROM local_entries WHERE evidence=?',(r['evidence'],)).rowcount
        elif op == 'revoke':
            fd=os.open(r['path']+'.revoked',os.O_CREAT|os.O_WRONLY|os.O_NOFOLLOW,0o600)
            try:
                st=os.fstat(fd)
                if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or st.st_mode & 0o077 or st.st_nlink!=1: raise ValueError('unsafe marker')
                os.fsync(fd)
            finally: os.close(fd)
            fd=os.open(os.path.dirname(r['path']),os.O_RDONLY|os.O_DIRECTORY)
            try: os.fsync(fd)
            finally: os.close(fd)
            db.execute('UPDATE local_identity SET revoked=1'); db.execute('UPDATE local_turns SET body=NULL')
            result=db.execute('DELETE FROM local_entries').rowcount
        else: raise ValueError('unknown operation')
        if not readonly: db.commit()
    print(json.dumps(result,ensure_ascii=False))
finally:
    for db in dbs.values(): db.close()
    for lock in locks: os.close(lock)
