import glob, subprocess, os, signal, json, time
files=sorted(set(glob.glob('test/chat-durable-*.test.js')+glob.glob('test/chat-main-*.test.js')+glob.glob('test/chat-trusted-*.test.js')))
results=[]
os.makedirs('regression-evidence',exist_ok=True)
for f in files:
    start=time.monotonic()
    p=subprocess.Popen(['/usr/bin/node','--test','--test-concurrency=1',f],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True)
    try: out,_=p.communicate(timeout=25); status=p.returncode
    except subprocess.TimeoutExpired:
        os.killpg(p.pid,signal.SIGKILL); out,_=p.communicate(); status='timeout'
    path='regression-evidence/'+os.path.basename(f)+'.log'
    with open(path,'wb') as h: h.write(out)
    results.append({'file':f,'status':status,'seconds':round(time.monotonic()-start,2),'log':path})
    print(json.dumps(results[-1]),flush=True)
with open('regression-evidence/results.json','w') as h: json.dump(results,h,indent=2)
print('SUMMARY',json.dumps({'total':len(results),'pass':sum(r['status']==0 for r in results),'failed':sum(isinstance(r['status'],int) and r['status']!=0 for r in results),'timeout':sum(r['status']=='timeout' for r in results)}),flush=True)
