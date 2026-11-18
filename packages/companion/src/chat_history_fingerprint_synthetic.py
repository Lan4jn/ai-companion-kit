"""Synthetic single-database experiment ONLY; not wired to application.

The key holder, SQLite writer, and snapshot/generation boundary are trusted.
This is not an offline converter or an anti-rollback mechanism.
"""
import hashlib, hmac, json, sqlite3


def canonical(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True)


class Candidate:
    def __init__(self, path, key):
        if len(key) != 32: raise ValueError('32-byte key required')
        self.key = key
        self.db = sqlite3.connect(path, isolation_level=None, timeout=5)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('''CREATE TABLE IF NOT EXISTS history(id TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tombstone(id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, input TEXT NOT NULL, output TEXT NOT NULL, dep TEXT NOT NULL, state TEXT NOT NULL, tag TEXT NOT NULL);''')

    def mac(self, domain, value):
        return hmac.new(self.key, (domain+'\0'+canonical(value)).encode(), hashlib.sha256).hexdigest()

    def add_history(self, identity, body):
        with self.transaction():
            if self.db.execute('SELECT 1 FROM tombstone WHERE id=?',(identity,)).fetchone(): raise ValueError('forgotten')
            self.db.execute('INSERT INTO history VALUES (?,?)',(identity,body))

    def transaction(self):
        return Transaction(self.db)

    def snapshot(self):
        # Snapshot is a signed commitment to the whole ordered current set, not
        # a caller-selected subset. Binding it to actual generation is external.
        rows=self.db.execute('SELECT id,body FROM history ORDER BY id').fetchall()
        deps=[[i,self.mac('history-v1',[i,b])] for i,b in rows]
        return {'deps':deps,'tag':self.mac('snapshot-v1',deps)}

    def forget(self, identity):
        with self.transaction():
            self.db.execute('INSERT OR IGNORE INTO tombstone VALUES (?)',(identity,))
            self.db.execute('DELETE FROM history WHERE id=?',(identity,))

    def prepare(self, identity, text, output, snapshot):
        deps=snapshot['deps']
        if not hmac.compare_digest(snapshot['tag'],self.mac('snapshot-v1',deps)): raise ValueError('snapshot integrity')
        dep=canonical(deps); state='ready'; fields=[identity,text,output,dep,state]
        with self.transaction():
            self.db.execute('INSERT INTO outbox VALUES (?,?,?,?,?,?)',(*fields,self.mac('outbox-v1',fields)))

    def checked(self, identity):
        row=self.db.execute('SELECT id,input,output,dep,state,tag FROM outbox WHERE id=?',(identity,)).fetchone()
        if not row or not hmac.compare_digest(row[-1],self.mac('outbox-v1',list(row[:-1]))): raise ValueError('integrity')
        return row

    def transition(self, row, state):
        fields=[*row[:4],state]
        self.db.execute('UPDATE outbox SET state=?,tag=? WHERE id=?',(state,self.mac('outbox-v1',fields),row[0]))

    def claim(self, identity):
        with self.transaction():
            row=self.checked(identity)
            if row[4] != 'ready': return row[4]
            for i, digest in json.loads(row[3]):
                current=self.db.execute('SELECT body FROM history WHERE id=?',(i,)).fetchone()
                if self.db.execute('SELECT 1 FROM tombstone WHERE id=?',(i,)).fetchone() or not current or not hmac.compare_digest(digest,self.mac('history-v1',[i,current[0]])): return 'blocked'
            self.transition(row,'unknown')
            return 'claimed'

    def ack(self, identity):
        # The real system requires an unforgeable in-process capability bound to
        # the specific claim and authenticated transport ACK. This toy does not.
        with self.transaction():
            row=self.checked(identity)
            if row[4]=='confirmed': return 'confirmed'
            if row[4]!='unknown': raise ValueError('not claimed')
            self.transition(row,'confirmed')
            return 'confirmed'

    def state(self, identity): return self.checked(identity)[4]
    def close(self): self.db.close()


class Transaction:
    def __init__(self, db): self.db=db
    def __enter__(self): self.db.execute('BEGIN IMMEDIATE')
    def __exit__(self, typ, value, tb): self.db.execute('ROLLBACK' if typ else 'COMMIT')
