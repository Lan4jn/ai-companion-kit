#!/usr/bin/python3
"""Manual-only, one-event offline migration. No historical authenticity claim."""
import argparse, fcntl, hashlib, importlib.util, json, os, re, sqlite3, stat, subprocess, sys, time, uuid
from pathlib import Path
from urllib.parse import quote

os.umask(0o077)
F = ('tenant','platform','type','session','user')
SOURCE = 'qq-private-message'
def sha(b): return hashlib.sha256(b).hexdigest()
def js(x): return json.dumps(x, ensure_ascii=False, separators=(',', ':'))
def safe_file(p):
    s=os.lstat(p)
    if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.getuid() or s.st_mode & 0o077 or s.st_nlink!=1: raise ValueError('unsafe file')
def no_sidecars(p):
    for suffix in ('-wal','-shm','-journal','.revoked'):
        if os.path.lexists(str(p)+suffix): raise ValueError('sidecar or revocation present')
def raw(p):
    safe_file(p)
    fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        with os.fdopen(fd,'rb') as f: return f.read()
    except BaseException: raise

def main():
    if not sys.stdin.isatty() or not sys.stderr.isatty(): raise ValueError('terminal required')
    a=argparse.ArgumentParser(); a.add_argument('directory'); a.add_argument('proof'); a.add_argument('tenant'); a.add_argument('user'); a.add_argument('event'); a.add_argument('--retention-ms',type=int,default=2592000000)
    x=a.parse_args()
    if not re.fullmatch(r'[1-9][0-9]*',x.user) or not re.fullmatch(r'onebot-message:(?:0|-?[1-9][0-9]*)',x.event) or not x.tenant or x.tenant.strip()!=x.tenant or len(x.tenant)>512 or not 0<x.retention_ms<=2592000000: raise ValueError('invalid selection')
    d=Path(x.directory)
    if not d.is_absolute() or str(d)!=os.path.realpath(d): raise ValueError('directory must be absolute and canonical')
    st=os.lstat(d)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.getuid() or st.st_mode & 0o077: raise ValueError('unsafe directory')
    proof=Path(x.proof)
    if not proof.is_absolute() or proof.parent!=d or str(proof)!=os.path.realpath(proof): raise ValueError('proof must be a direct file in restricted directory')
    scope=dict(zip(F,(x.tenant,'qq','private','private:'+x.user,x.user)))
    stem=sha(js([scope,SOURCE]).encode()); legacy=d/(stem+'.sqlite3'); target=d/('sqlite-fts-v1-'+stem+'.sqlite3'); ame=d/('ame-v1-'+stem+'.sqlite3')
    lockname='.forget-lock-'+sha(js([str(d),*[scope[k] for k in F],SOURCE]).encode())
    lock=os.open(d/lockname,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    try:
        s=os.fstat(lock)
        if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.getuid() or s.st_mode & 0o077 or s.st_nlink!=1: raise ValueError('unsafe lock')
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        spec=importlib.util.spec_from_file_location('migration_preflight',Path(__file__).with_name('memory-offline-preflight.py'))
        preflight=importlib.util.module_from_spec(spec); spec.loader.exec_module(preflight)
        def check_visible():
            report=preflight.inspect(str(d))
            external_locks=[item for item in report['sqlite_locks'] if len(item['kernel_record'].split())<5 or item['kernel_record'].split()[4]!=str(os.getpid())]
            if report['inspection_warnings'] or report['open_files'] or report['mapped_files'] or external_locks:
                raise ValueError('visible process, lock, or incomplete inspection; stop writers and inspect preflight')
        check_visible()
        no_sidecars(legacy); no_sidecars(target); no_sidecars(ame)
        if os.path.lexists(ame): raise ValueError('AME state present; manually reconcile first')
        # A real SQLite writer reservation prevents concurrent source writes.
        # Filesystem markers and unrelated backends still require human quiescence.
        safe_file(legacy)
        source_fd=os.open(legacy,os.O_RDONLY|os.O_NOFOLLOW)
        def source_hash():
            os.lseek(source_fd,0,os.SEEK_SET); h=hashlib.sha256()
            while True:
                b=os.read(source_fd,1024*1024)
                if not b: break
                h.update(b)
            held=os.fstat(source_fd); current=os.stat(legacy,follow_symlinks=False)
            if (current.st_dev,current.st_ino)!=(held.st_dev,held.st_ino) or not stat.S_ISREG(held.st_mode) or held.st_uid!=os.getuid() or held.st_mode & 0o077 or held.st_nlink!=1: raise ValueError('source replaced or unsafe')
            return h.hexdigest()
        source_guard=sqlite3.connect('file:'+quote(str(legacy),safe='/')+'?mode=rw',uri=True,timeout=0)
        source_guard.execute('BEGIN IMMEDIATE')
        no_sidecars(legacy)
        source_digest=source_hash(); proof_bytes=raw(proof); proof_digest=sha(proof_bytes)
        p=json.loads(proof_bytes)
        if set(p)!={'scope','source','event','text','created_at','provenance'} or p['scope']!=scope or p['source']!=SOURCE or p['event']!=x.event or not isinstance(p['provenance'],str) or not p['provenance'].strip() or len(p['provenance'])>1000: raise ValueError('proof selection mismatch')
        db=source_guard
        try:
            policy=db.execute('SELECT revoked FROM adapter_policy WHERE id=1').fetchone()
            if policy and policy[0]!=0: raise ValueError('revoked source')
            if db.execute('SELECT 1 FROM adapter_forget_tombstones WHERE evidence_hash=?',(sha(x.event.encode()),)).fetchone(): raise ValueError('forgotten')
            retention=db.execute('SELECT retention_ms FROM adapter_retention WHERE id=1').fetchone()
            if not retention or type(retention[0])!=int or retention[0]<x.retention_ms: raise ValueError('retention mismatch')
            rows=db.execute("SELECT text,source,meta,created_at FROM memories WHERE status='active' AND visibility='private' AND json_valid(meta) AND json_extract(meta,'$.evidence')=? LIMIT 2",(x.event,)).fetchall()
            if len(rows)!=1: raise ValueError('source event missing or ambiguous')
            text,source,meta,created=rows[0]; meta=json.loads(meta)
            if source!=SOURCE or meta.get('adapter_version')!=1 or meta.get('scope')!=scope or text!=p['text'] or created!=p['created_at'] or not isinstance(text,str) or not text.strip() or len(text)>512 or not isinstance(created,(int,float)) or isinstance(created,bool) or not time.time()-x.retention_ms/1000<created<=time.time(): raise ValueError('proof and source disagree')
        finally: pass
        target_digest=sha(raw(target)) if target.exists() else 'absent'
        if target.exists():
            db=sqlite3.connect('file:'+quote(str(target),safe='/')+'?mode=ro&immutable=1',uri=True)
            try:
                identity=db.execute('SELECT identity,retention,revoked FROM local_identity').fetchall()
                expected=json.dumps([scope,SOURCE],ensure_ascii=False,sort_keys=True,separators=(',',':'))
                if len(identity)!=1 or identity[0][0]!=expected or identity[0][1]<x.retention_ms or identity[0][2]!=0: raise ValueError('target identity or retention mismatch')
                if db.execute('SELECT 1 FROM local_tombstones WHERE digest=?',(sha(x.event.encode()),)).fetchone(): raise ValueError('forgotten')
            finally: db.close()
        audit=d/'offline-migration-audit.sqlite3'
        if audit.exists(): safe_file(audit)
        else:
            fd=os.open(audit,os.O_CREAT|os.O_EXCL|os.O_RDWR|os.O_NOFOLLOW,0o600); os.close(fd)
        ledger=sqlite3.connect(audit,timeout=5)
        try:
            ledger.execute('PRAGMA synchronous=FULL'); ledger.execute('CREATE TABLE IF NOT EXISTS attempts (event_key TEXT PRIMARY KEY, authorization TEXT UNIQUE, issued INTEGER, expires INTEGER, scope_hash TEXT, source_hash TEXT, event_hash TEXT, source_digest TEXT, target_digest TEXT, proof_digest TEXT, status TEXT)'); ledger.commit()
            event_key=sha(js([scope,SOURCE,x.event]).encode())
            if ledger.execute('SELECT 1 FROM attempts WHERE event_key=?',(event_key,)).fetchone(): raise ValueError('already attempted; outcome must be reconciled manually, never retry')
            token=uuid.uuid4().hex; issued=int(time.time()); expires=issued+300
            sys.stderr.write('\n离线前提：从校验到提交必须确保源端、目标端及相关后端的全部写入和遗忘操作停止；本工具无法验证或强制外部写者停写。源库与目标库并非原子跨库，撤销标记也不在SQLite事务内。无法保证停写时请取消。\n人工责任：此导入证据不是历史真实性的密码学证明。请独立检查原始来源和授权；确认以下内容与来源一致。\n'+js({'scope':scope,'source':SOURCE,'event':x.event,'text':text,'created_at':created,'provenance':p['provenance'],'source_sha256':source_digest,'target_sha256':target_digest,'proof_sha256':proof_digest,'expires':expires})+'\n输入 CONFIRM '+token+' 授权一次：'); sys.stderr.flush()
            if input().strip()!='CONFIRM '+token or time.time()>expires: raise ValueError('confirmation absent or expired')
            # Hashes alone cannot detect new WALs or revocation markers while the operator reviews.
            check_visible()
            no_sidecars(legacy); no_sidecars(target); no_sidecars(ame)
            if os.path.lexists(ame): raise ValueError('AME state present; manually reconcile first')
            if source_hash()!=source_digest or sha(raw(proof))!=proof_digest or (sha(raw(target)) if target.exists() else 'absent')!=target_digest: raise ValueError('files changed after confirmation')
            ledger.execute('BEGIN IMMEDIATE')
            ledger.execute('INSERT INTO attempts VALUES (?,?,?,?,?,?,?,?,?,?,?)',(event_key,token,issued,expires,sha(js(scope).encode()),sha(SOURCE.encode()),sha(x.event.encode()),source_digest,target_digest,proof_digest,'attempt')); ledger.commit()
            if time.time()>expires: raise ValueError('authorization expired after reservation')
            request={'scope':scope,'source':SOURCE,'path':str(target),'retentionMs':x.retention_ms,'operation':'migrateLegacyEvidence','record':{'scope':scope,'source':SOURCE,'evidence':x.event,'text':text,'created_at':created}}
            worker=Path(__file__).resolve().parent.parent/'src/memory-sqlite-fts-worker.py'
            if not target.exists():
                fd=os.open(target,os.O_CREAT|os.O_EXCL|os.O_RDWR|os.O_NOFOLLOW,0o600); os.close(fd)
            # Worker re-acquires and verifies the source reservation before any
            # target write, and holds it if this parent dies. The handoff gap is
            # checked with digest/sidecars; external markers remain human-controlled.
            source_guard.close()
            request['sourceGuard']={'path':str(legacy),'digest':source_digest}
            request['authorization']=token
            res=subprocess.run(['/usr/bin/python3',str(worker),''],input=js(request),text=True,capture_output=True,timeout=10,pass_fds=(lock,),env={'LANG':'C.UTF-8','PATH':'/usr/bin:/bin'})
            if res.returncode: raise ValueError('execution outcome unknown; never retry')
            result=json.loads(res.stdout)
            if result.get('status') not in ('inserted','duplicate','forgotten'): raise ValueError('execution outcome unknown; never retry')
            if ledger.execute("UPDATE attempts SET status=? WHERE event_key=? AND authorization=? AND status='consumed'",(result['status'],event_key,token)).rowcount != 1: raise ValueError('audit outcome unknown; never retry')
            ledger.commit()
            print(js(result))
        finally: ledger.close()
    finally: os.close(lock)
if __name__=='__main__':
    try: main()
    except Exception as e:
        print('offline migration refused or outcome unknown: '+str(e),file=sys.stderr); sys.exit(1)
