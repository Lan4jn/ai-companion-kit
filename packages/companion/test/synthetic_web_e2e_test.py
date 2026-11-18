#!/usr/bin/env python3
"""Offline synthetic end-to-end probe; run as root, never use production sessions."""
import asyncio, ipaddress, os, signal, socket, sys, time
from pathlib import Path
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from synthetic_lan_relay import SyntheticRelay

async def probe(mode):
    p = await asyncio.create_subprocess_exec(sys.executable, str(ROOT/'scripts/isolated-login-prototype.py'), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, start_new_session=True)
    relay = None
    try:
        line = (await asyncio.wait_for(p.stdout.readline(), 15)).decode().strip()
        assert line.startswith('SOCKET='), (line, await p.stderr.read())
        path=line[7:]; tokenline=(await asyncio.wait_for(p.stdout.readline(),5)).decode().strip()
        assert tokenline.startswith('TOKEN='); broker_token=tokenline[6:]
        viewer=(ROOT/'scripts/synthetic_web_viewer.html').read_text()
        with socket.socket() as reserve:
            reserve.bind(('127.0.0.1',0)); port=reserve.getsockname()[1]
        origin=f'http://127.0.0.1:{port}'
        relay=SyntheticRelay('127.0.0.1',port,ipaddress.ip_network('127.0.0.0/8'),origin,path,ttl=45,upstream_token=broker_token,page=viewer)
        await relay.start()
        url=f'ws://127.0.0.1:{relay.port}/relay'
        try:
            async with connect(url, origin='http://evil.invalid') as bad: pass
            raise AssertionError('wrong Origin accepted')
        except InvalidStatus: pass
        async with connect(url, origin=relay.origin) as bad:
            await bad.send('incorrect')
            try: await asyncio.wait_for(bad.recv(),3); raise AssertionError('wrong token accepted')
            except ConnectionClosed: pass
        assert not relay.claimed
        # Browser consumes the one-shot session, is touch-emulated at phone size,
        # and tests replay while the authenticated connection remains alive.
        env={**os.environ,'SYNTH_URL':relay.origin+'/#'+relay.token,'SYNTH_MODE':mode}
        client=await asyncio.create_subprocess_exec('node',str(ROOT/'test/synthetic_web_client_probe.cjs'),env=env,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
        out,err=await asyncio.wait_for(client.communicate(),35)
        assert client.returncode==0,(out.decode(),err.decode())
        assert b'PASS' in out, out
        # Browser disconnect is a revocation: launcher must exit, broker socket gone.
        rest, stderr=await asyncio.wait_for(p.communicate(),12)
        assert p.returncode==0,stderr.decode()
        assert b'SYNTHETIC_FIXTURE_IMPORTED' in rest,rest
        assert not os.path.exists(path)
        print(f'PASS {mode}: Origin and token rejected; phone browser input reached same synthetic page; replay rejected; disconnect revoked',flush=True)
    finally:
        if relay: await relay.close()
        if p.returncode is None:
            os.killpg(p.pid,signal.SIGTERM)
            try: await asyncio.wait_for(p.wait(),10)
            except asyncio.TimeoutError: os.killpg(p.pid,signal.SIGKILL); await p.wait()

async def race():
    p=await asyncio.create_subprocess_exec(sys.executable,str(ROOT/'scripts/isolated-login-prototype.py'),stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE,start_new_session=True)
    relay=None
    try:
        path=(await asyncio.wait_for(p.stdout.readline(),15)).decode().strip().removeprefix('SOCKET=')
        secret=(await asyncio.wait_for(p.stdout.readline(),5)).decode().strip().removeprefix('TOKEN=')
        relay=SyntheticRelay('127.0.0.1',0,ipaddress.ip_network('127.0.0.0/8'),'http://synthetic.invalid',path,ttl=30,upstream_token=secret)
        await relay.start()
        url=f'ws://127.0.0.1:{relay.port}/relay'
        a,b=await asyncio.gather(connect(url,origin=relay.origin),connect(url,origin=relay.origin))
        await asyncio.gather(a.send(relay.token),b.send(relay.token))
        async def result(ws):
            try: return await asyncio.wait_for(ws.recv(),5)
            except ConnectionClosed: return b''
        received=await asyncio.gather(result(a),result(b))
        assert sum(x==b'RFB 003.008\n' for x in received)==1,received
        await asyncio.gather(a.close(),b.close())
        _,err=await asyncio.wait_for(p.communicate(),12)
        assert p.returncode==0,err.decode()
        assert not os.path.exists(path)
        print('PASS concurrent first claims: exactly one real Xvnc banner; disconnect revoked',flush=True)
    finally:
        if relay: await relay.close()
        if p.returncode is None:
            os.killpg(p.pid,signal.SIGTERM)
            try: await asyncio.wait_for(p.wait(),10)
            except asyncio.TimeoutError: os.killpg(p.pid,signal.SIGKILL); await p.wait()

async def child():
    # The network namespace is different from the calling host, with only loopback.
    assert os.stat('/proc/self/ns/net').st_ino != os.stat(f'/proc/{os.getppid()}/ns/net').st_ino
    proc=await asyncio.create_subprocess_exec('ip','link','set','lo','up'); assert await proc.wait()==0
    await race()
    for mode in ('mouse','touch'): await probe(mode)

if __name__=='__main__':
    if sys.argv[1:]==['--child']: asyncio.run(child())
    elif not sys.argv[1:]:
        os.execvp('unshare',['unshare','--net',sys.executable,__file__,'--child'])
    else: raise SystemExit('no options')
