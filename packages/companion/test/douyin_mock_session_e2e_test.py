#!/usr/bin/env python3
"""Loopback-only synthetic headed-session test; no real accounts or platform."""
import asyncio, ipaddress, os, signal, socket, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from synthetic_lan_relay import SyntheticRelay

async def run():
    assert os.stat('/proc/self/ns/net').st_ino != os.stat(f'/proc/{os.getppid()}/ns/net').st_ino
    assert await (await asyncio.create_subprocess_exec('ip','link','set','lo','up')).wait() == 0
    p = await asyncio.create_subprocess_exec(sys.executable, str(ROOT/'scripts/douyin_mock_session_candidate.py'), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, start_new_session=True)
    relay = None
    try:
        line = (await asyncio.wait_for(p.stdout.readline(), 15)).decode().strip()
        assert line.startswith('SOCKET='), (line, (await p.stderr.read()).decode())
        path = line[7:]
        secret = (await asyncio.wait_for(p.stdout.readline(), 5)).decode().strip().removeprefix('TOKEN=')
        with socket.socket() as s:
            s.bind(('127.0.0.1', 0)); port=s.getsockname()[1]
        origin=f'http://127.0.0.1:{port}'
        relay=SyntheticRelay('127.0.0.1',port,ipaddress.ip_network('127.0.0.0/8'),origin,path,ttl=45,upstream_token=secret,page=(ROOT/'scripts/synthetic_web_viewer.html').read_text())
        await relay.start()
        env={**os.environ,'SYNTH_URL':origin+'/#'+relay.token}
        client=await asyncio.create_subprocess_exec('node',str(ROOT/'test/douyin_mock_session_client.cjs'),env=env,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
        out,err=await asyncio.wait_for(client.communicate(),35)
        assert client.returncode==0,(out.decode(),err.decode())
        rest,err=await asyncio.wait_for(p.communicate(),12)
        assert p.returncode==0,err.decode()
        assert b'MOCK_SAME_SESSION_VERIFIED' in rest,rest
        assert not os.path.exists(path)
        print('PASS same headed browser: mock red -> blue -> green; one-shot viewer disconnect revoked')
    finally:
        if relay: await relay.close()
        if p.returncode is None:
            os.killpg(p.pid,signal.SIGTERM)
            try: await asyncio.wait_for(p.wait(),10)
            except asyncio.TimeoutError: os.killpg(p.pid,signal.SIGKILL); await p.wait()

if __name__=='__main__':
    if sys.argv[1:]==['--child']: asyncio.run(run())
    elif not sys.argv[1:]: os.execvp('unshare',['unshare','--net',sys.executable,__file__,'--child'])
    else: raise SystemExit('no options')
