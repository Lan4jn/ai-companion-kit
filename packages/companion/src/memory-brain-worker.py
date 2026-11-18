"""Single-operation bridge to the real memory_core engine; stdin contains private data."""
import json
import os
import sqlite3
import sys
import fcntl
import hashlib
import stat
import time

os.umask(0o077)
if len(sys.argv) != 2 or not os.path.isabs(sys.argv[1]):
    raise ValueError('absolute engine root required')
sys.path.insert(0, sys.argv[1])
from memory_core.store import Store
from memory_core.engine import MemoryEngine

request = json.load(sys.stdin)
if request['operation'] == 'privateHistory':
    # Coordinate with the writer's existing lock without creating any files.
    from urllib.parse import quote
    lock = os.open(request['path'] + '.lock', os.O_RDONLY | os.O_NOFOLLOW)
    try:
        st = os.fstat(lock)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077 or st.st_nlink != 1:
            raise ValueError('unsafe lock')
        fcntl.flock(lock, fcntl.LOCK_SH)
        if os.path.lexists(request['path'] + '.revoked'):
            raise ValueError('source revoked')
        wal = request['path'] + '-wal'
        shm = request['path'] + '-shm'
        # SQLite mode=ro can create empty WAL/SHM files. A locked, fully
        # checkpointed database can instead be opened immutable. A live WAL
        # requires its existing SHM; never discard WAL via immutable mode.
        if os.path.lexists(wal):
            if not os.path.isfile(wal) or not os.path.isfile(shm):
                raise ValueError('WAL state unavailable')
            options = '?mode=ro'
        else:
            options = '?mode=ro&immutable=1'
        uri = 'file:' + quote(request['path'], safe='/') + options
        db = sqlite3.connect(uri, uri=True)
        try:
            db.execute('PRAGMA query_only=ON')
            db.execute('BEGIN')
            policy = db.execute('SELECT revoked FROM adapter_policy WHERE id=1').fetchone()
            if policy and policy[0] != 0:
                raise ValueError('source revoked')
            retention = db.execute('SELECT retention_ms FROM adapter_retention WHERE id=1').fetchone()
            if not retention or not isinstance(retention[0], int) or retention[0] <= 0:
                raise ValueError('invalid retention')
            tombstones = {r[0] for r in db.execute('SELECT evidence_hash FROM adapter_forget_tombstones')}
            if any(not isinstance(v, str) or len(v) != 64 or any(c not in '0123456789abcdef' for c in v) for v in tombstones):
                raise ValueError('invalid forget tombstone')
            result = []
            cutoff = time.time() - min(retention[0], request['retentionMs']) / 1000
            for text, source, raw_meta, created in db.execute("SELECT text, source, meta, created_at FROM memories WHERE status='active' AND visibility='private' AND created_at>? ORDER BY created_at DESC, id DESC", (cutoff,)):
                try:
                    meta = json.loads(raw_meta)
                except (ValueError, TypeError):
                    continue
                if (not isinstance(meta, dict) or source != request['source'] or meta.get('scope') != request['scope'] or meta.get('adapter_version') != 1 or not isinstance(meta.get('evidence'), str) or not meta['evidence'].startswith('onebot-message:') or not __import__('re').fullmatch(r'(?:0|-?[1-9][0-9]*)', meta['evidence'][15:]) or not isinstance(text, str) or not text.strip()):
                    continue
                if hashlib.sha256(meta['evidence'].encode('utf-8')).hexdigest() in tombstones:
                    continue
                result.append({'text': text, 'source': source, 'evidence': meta['evidence'], 'created_at': created})
                if len(result) == request['limit']:
                    break
            print(json.dumps(list(reversed(result)), ensure_ascii=False))
        finally:
            db.close()
    finally:
        os.close(lock)
    sys.exit(0)
# Candidate ranking is deliberately ephemeral. The source ledger remains the
# authority for eligibility, deletion, evidence and retention on every query.
locks = []
forgotten = set()
for item in (request['scopes'] if request['operation'] in ('rankCandidates', 'filterCandidates') else [request]):
    lock = os.open(item['path'] + '.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    st = os.fstat(lock)
    if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077 or st.st_nlink != 1:
        raise ValueError('unsafe lock')
    fcntl.flock(lock, fcntl.LOCK_EX)
    locks.append(lock)
    marker = item['path'] + '.revoked'
    if request['operation'] == 'revoke':
        fd = os.open(marker, os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        marker_stat = os.fstat(fd)
        if not stat.S_ISREG(marker_stat.st_mode) or marker_stat.st_uid != os.getuid() or marker_stat.st_mode & 0o077 or marker_stat.st_nlink != 1:
            raise ValueError('unsafe revocation marker')
        os.fsync(fd)
        os.close(fd)
        directory_fd = os.open(os.path.dirname(marker), os.O_RDONLY | os.O_DIRECTORY)
        os.fsync(directory_fd)
        os.close(directory_fd)
    elif os.path.lexists(marker):
        raise ValueError('source revoked')
    if request['operation'] in ('rankCandidates', 'filterCandidates'):
        with sqlite3.connect(item['path']) as policy_db:
            exists = policy_db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='adapter_policy'").fetchone()
            if exists and policy_db.execute('SELECT revoked FROM adapter_policy WHERE id=1').fetchone() == (1,):
                raise ValueError('source revoked')
            has_tombstones = policy_db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='adapter_forget_tombstones'").fetchone()
            if has_tombstones:
                forgotten.update((item['source'], row[0]) for row in policy_db.execute('SELECT evidence_hash FROM adapter_forget_tombstones'))
store = Store(':memory:' if request['operation'] in ('rankCandidates', 'filterCandidates') else request['path'])

def delete_memory(mid):
    for table in ('memories_fts', 'vectors', 'memory_entities', 'relations'):
        store.conn.execute('DELETE FROM ' + table + ' WHERE memory_id=?', (mid,))
    store.conn.execute('DELETE FROM conflicts WHERE a_id=? OR b_id=?', (mid, mid))
    store.conn.execute('DELETE FROM memories WHERE id=?', (mid,))

try:
    if request['operation'] not in ('rankCandidates', 'filterCandidates'):
        store.conn.execute('CREATE TABLE IF NOT EXISTS adapter_policy (id INTEGER PRIMARY KEY CHECK(id=1), revoked INTEGER NOT NULL)')
        store.conn.execute('CREATE TABLE IF NOT EXISTS adapter_forget_tombstones (evidence_hash TEXT PRIMARY KEY)')
        store.conn.execute('CREATE TABLE IF NOT EXISTS chat_turns (turn_hash TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, body TEXT)')
        store.conn.execute('CREATE TABLE IF NOT EXISTS chat_turn_events (event_hash TEXT PRIMARY KEY, turn_hash TEXT NOT NULL)')
        store.conn.execute('PRAGMA secure_delete=ON')
        store.conn.execute('CREATE TABLE IF NOT EXISTS adapter_retention (id INTEGER PRIMARY KEY CHECK(id=1), retention_ms INTEGER NOT NULL)')
        store.conn.execute('INSERT INTO adapter_retention VALUES (1,?) ON CONFLICT(id) DO UPDATE SET retention_ms=MIN(retention_ms,excluded.retention_ms)', (request['retentionMs'],))
        effective_retention = store.conn.execute('SELECT retention_ms FROM adapter_retention WHERE id=1').fetchone()[0]
        store.conn.commit()
        policy = store.conn.execute('SELECT revoked FROM adapter_policy WHERE id=1').fetchone()
        if policy and policy[0] and request['operation'] != 'revoke':
            raise ValueError('source revoked')
        store.conn.execute('BEGIN IMMEDIATE')
        if request['operation'] == 'cleanup':
            for row in store.conn.execute('SELECT source, meta FROM memories'):
                try:
                    meta = json.loads(row['meta'])
                except (ValueError, TypeError):
                    raise ValueError('invalid provenance')
                if (not isinstance(meta, dict) or row['source'] != request['source'] or meta.get('scope') != request['scope']
                        or meta.get('adapter_version') != 1 or not isinstance(meta.get('evidence'), str) or not meta['evidence']):
                    raise ValueError('invalid provenance')
        expired = [row[0] for row in store.conn.execute('SELECT id FROM memories WHERE created_at <= ?', (time.time() - effective_retention / 1000,))]
        for mid in expired:
            delete_memory(mid)
        store.conn.commit()
    engine = MemoryEngine(store)
    if request['operation'] == 'filterCandidates':
        result = [i for i, record in enumerate(request['candidates']) if (record['source'], hashlib.sha256(record['evidence'].encode('utf-8')).hexdigest()) not in forgotten]
    elif request['operation'] == 'rankCandidates':
        originals = {}
        for record in request['candidates']:
            evidence_hash = hashlib.sha256(record['evidence'].encode('utf-8')).hexdigest()
            if (record['source'], evidence_hash) in forgotten:
                continue
            mid = engine.remember(record['text'], source=record['source'], visibility='private')
            originals[mid] = record
        result = [originals[hit['id']] for hit in engine.recall(request['query'], k=request['limit'], touch=False)]
    elif request['operation'] == 'cleanup':
        result = len(expired)
    elif request['operation'] == 'remember':
        record = request['record']
        evidence_hash = hashlib.sha256(record['evidence'].encode('utf-8')).hexdigest()
        if store.conn.execute('SELECT 1 FROM adapter_forget_tombstones WHERE evidence_hash=?', (evidence_hash,)).fetchone():
            raise ValueError('evidence forgotten')
        # Unique evidence within this scope/source DB makes redelivery and concurrent
        # workers idempotent, including a retry after an uncertain worker response.
        store.conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS adapter_evidence_unique ON memories(json_extract(meta, '$.evidence')) WHERE json_extract(meta, '$.adapter_version') = 1")
        store.conn.commit()
        try:
            result = engine.remember(record['text'], source=record['source'], visibility='private',
                                     meta={'scope': request['scope'], 'evidence': record['evidence'], 'adapter_version': 1})
        except sqlite3.IntegrityError:
            store.conn.rollback()
            row = store.conn.execute("SELECT id, text, source, meta FROM memories WHERE json_extract(meta, '$.adapter_version') = 1 AND json_extract(meta, '$.evidence') = ?", (record['evidence'],)).fetchone()
            if not row or row['text'] != record['text'] or row['source'] != record['source'] or json.loads(row['meta']).get('scope') != request['scope']:
                raise
            result = row['id']
    elif request['operation'] == 'requireChatHistoryCapacity':
        result = store.conn.execute('SELECT COUNT(*) FROM chat_turns').fetchone()[0] < request['maxChatHistoryTurns']
    elif request['operation'] == 'commitChatHistory':
        turn = request['turn']
        digest = lambda value: hashlib.sha256(value.encode('utf-8')).hexdigest()
        turn_hash = digest(turn['turnId'])
        event_hashes = [digest(e) for e in turn['events']]
        body = json.dumps(turn, ensure_ascii=False, separators=(',', ':'))
        payload_hash = digest(body)
        store.conn.execute('BEGIN IMMEDIATE')
        forgotten_event = any(store.conn.execute('SELECT 1 FROM adapter_forget_tombstones WHERE evidence_hash=?', (h,)).fetchone() for h in event_hashes)
        old = store.conn.execute('SELECT payload_hash, body FROM chat_turns WHERE turn_hash=?', (turn_hash,)).fetchone()
        if forgotten_event or (old and old['body'] is None):
            result = 'forgotten'
        elif old:
            if old['payload_hash'] != payload_hash:
                raise ValueError('turn identity conflict')
            result = 'duplicate'
        else:
            if store.conn.execute('SELECT COUNT(*) FROM chat_turns').fetchone()[0] >= request['maxChatHistoryTurns']:
                raise ValueError('chat history capacity')
            for h in event_hashes:
                if store.conn.execute('SELECT 1 FROM chat_turn_events WHERE event_hash=?', (h,)).fetchone():
                    raise ValueError('event identity conflict')
            store.conn.execute('INSERT INTO chat_turns VALUES (?,?,?)', (turn_hash,payload_hash,body))
            store.conn.executemany('INSERT INTO chat_turn_events VALUES (?,?)', [(h,turn_hash) for h in event_hashes])
            result = 'inserted'
        store.conn.commit()
    elif request['operation'] == 'chatHistory':
        store.conn.execute('BEGIN IMMEDIATE')
        rows = store.conn.execute('SELECT body FROM chat_turns WHERE body IS NOT NULL ORDER BY rowid DESC LIMIT ?', (request['limit'],)).fetchall()
        result = [json.loads(row['body']) for row in reversed(rows)]
        store.conn.commit()
    elif request['operation'] == 'revoke':
        store.conn.execute('BEGIN IMMEDIATE')
        store.conn.execute('UPDATE chat_turns SET body=NULL')
        store.conn.execute('INSERT INTO adapter_policy VALUES (1,1) ON CONFLICT(id) DO UPDATE SET revoked=1')
        ids = [row[0] for row in store.conn.execute('SELECT id FROM memories')]
        for mid in ids:
            delete_memory(mid)
        store.conn.commit()
        result = len(ids)
    elif request['operation'] == 'forget':
        # Serialize the provenance check and deletion against concurrent writers.
        store.conn.execute('BEGIN IMMEDIATE')
        evidence_hash = hashlib.sha256(request['evidence'].encode('utf-8')).hexdigest()
        if request.get('exactSingle'):
            # Recheck under the same transaction as deletion: a concurrent writer
            # must not turn an individually verified event into a merged batch.
            linked = store.conn.execute('SELECT turn_hash FROM chat_turn_events WHERE event_hash=?', (evidence_hash,)).fetchall()
            if linked:
                turn_hash = linked[0][0]
                count = store.conn.execute('SELECT COUNT(*) FROM chat_turn_events WHERE turn_hash=?', (turn_hash,)).fetchone()[0]
                if len(linked) != 1 or count != 1:
                    raise ValueError('ambiguous merged turn')
        matches = []
        for row in store.conn.execute('SELECT id, source, meta FROM memories'):
            try:
                meta = json.loads(row['meta'])
            except (ValueError, TypeError):
                raise ValueError('invalid provenance')
            if (not isinstance(meta, dict) or row['source'] != request['source'] or meta.get('scope') != request['scope']
                    or meta.get('adapter_version') != 1 or not isinstance(meta.get('evidence'), str) or not meta['evidence']):
                raise ValueError('invalid provenance')
            if meta['evidence'] == request['evidence']:
                matches.append(row['id'])
        if request.get('exactSingle'):
            live_turns = store.conn.execute('SELECT COUNT(*) FROM chat_turns WHERE body IS NOT NULL AND turn_hash IN (SELECT turn_hash FROM chat_turn_events WHERE event_hash=?)', (evidence_hash,)).fetchone()[0]
            if len(matches) + live_turns != 1:
                raise ValueError('missing or ambiguous exact target')
        store.conn.execute('INSERT OR IGNORE INTO adapter_forget_tombstones VALUES (?)', (evidence_hash,))
        store.conn.execute('UPDATE chat_turns SET body=NULL WHERE turn_hash IN (SELECT turn_hash FROM chat_turn_events WHERE event_hash=?)', (evidence_hash,))
        for mid in matches:
            store.conn.execute('DELETE FROM memories_fts WHERE memory_id=?', (mid,))
            store.conn.execute('DELETE FROM vectors WHERE memory_id=?', (mid,))
            store.conn.execute('DELETE FROM memory_entities WHERE memory_id=?', (mid,))
            store.conn.execute('DELETE FROM relations WHERE memory_id=?', (mid,))
            store.conn.execute('DELETE FROM conflicts WHERE a_id=? OR b_id=?', (mid, mid))
            store.conn.execute('DELETE FROM memories WHERE id=?', (mid,))
        store.conn.commit()
        result = len(matches)
    elif request['operation'] == 'recall':
        # Never let provenance-free or misplaced rows influence candidate generation,
        # ranking or graph expansion, even if a database was externally modified.
        for original in store.conn.execute('SELECT source, meta FROM memories'):
            try:
                meta = json.loads(original['meta'])
            except (ValueError, TypeError):
                raise ValueError('invalid provenance')
            if (original['source'] != request['source'] or meta.get('scope') != request['scope']
                    or meta.get('adapter_version') != 1 or not isinstance(meta.get('evidence'), str) or not meta['evidence']):
                raise ValueError('invalid provenance')
        result = []
        for hit in engine.recall(request['query'], k=request['limit'], touch=False):
            original = store.get_memory(hit['id'])
            meta = original.get('meta') or {}
            if (original.get('source') != request['source'] or meta.get('scope') != request['scope']
                    or meta.get('adapter_version') != 1 or not isinstance(meta.get('evidence'), str) or not meta['evidence']):
                continue
            hit.update(source=original['source'], evidence=meta['evidence'])
            result.append(hit)
    else:
        raise ValueError('unknown operation')
    print(json.dumps(result, ensure_ascii=False))
finally:
    store.conn.close()
