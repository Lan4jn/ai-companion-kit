"""Offline synthetic-only websocket to Unix-stream relay tests."""
import asyncio
import ipaddress
import os
import sys
import tempfile
import unittest
from pathlib import Path

import websockets

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from synthetic_lan_relay import SyntheticRelay


class RelayTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR'))
        self.path = os.path.join(self.tmp.name, 'fixture.sock')
        async def fixture(reader, writer):
            try:
                while data := await reader.read(4096):
                    writer.write(b'fixture:' + data)
                    await writer.drain()
            finally:
                writer.close()
                await writer.wait_closed()
        self.upstream = await asyncio.start_unix_server(fixture, path=self.path)
        self.relay = SyntheticRelay('127.0.0.1', 0, ipaddress.ip_network('127.0.0.0/8'),
                                    'http://127.0.0.1:18889', self.path, ttl=3)
        await self.relay.start()
        self.url = f'ws://127.0.0.1:{self.relay.port}/relay'

    async def asyncTearDown(self):
        await self.relay.close()
        self.upstream.close()
        await self.upstream.wait_closed()
        self.tmp.cleanup()

    async def connect(self, origin='http://127.0.0.1:18889'):
        return await websockets.connect(self.url, origin=origin, proxy=None)

    async def test_only_one_valid_client_can_relay_binary_data(self):
        token = self.relay.token
        async with await self.connect() as ws:
            await ws.send(token)
            await ws.send(b'test')
            self.assertEqual(await ws.recv(), b'fixture:test')
            async with await self.connect() as replay:
                await replay.send(token)
                with self.assertRaises(websockets.ConnectionClosed):
                    await replay.recv()
        async with await self.connect() as replay:
            await replay.send(token)
            with self.assertRaises(websockets.ConnectionClosed):
                await replay.recv()

    async def test_wrong_token_and_origin_do_not_consume_grant(self):
        try:
            async with await self.connect('http://evil.invalid') as wrong:
                await wrong.send(self.relay.token)
                await wrong.recv()
        except (websockets.ConnectionClosed, websockets.InvalidStatus):
            pass
        else:
            self.fail('bad origin accepted')
        async with await self.connect() as wrong:
            await wrong.send('invalid')
            with self.assertRaises(websockets.ConnectionClosed):
                await wrong.recv()
        async with await self.connect() as valid:
            await valid.send(self.relay.token)
            await valid.send(b'ok')
            self.assertEqual(await valid.recv(), b'fixture:ok')

    async def test_rejects_non_loopback_listener(self):
        with self.assertRaises(ValueError):
            SyntheticRelay('0.0.0.0', 0, ipaddress.ip_network('192.168.0.0/16'),
                           'http://example.invalid', self.path)

    async def test_invalid_origin_does_not_log_attacker_header(self):
        import logging
        records = []
        class Capture(logging.Handler):
            def emit(self, record):
                records.append(self.format(record))
        logger = logging.getLogger()
        handler = Capture()
        logger.addHandler(handler)
        try:
            try:
                async with await self.connect('http://sensitive-header.invalid') as ws:
                    await ws.recv()
            except (websockets.ConnectionClosed, websockets.InvalidStatus):
                pass
            await asyncio.sleep(.05)
            self.assertFalse(any('sensitive-header' in record for record in records))
        finally:
            logger.removeHandler(handler)

    async def test_expiry_closes_active_connection(self):
        async with await self.connect() as ws:
            # Start the expiry budget only after the WebSocket handshake.
            self.relay.deadline = asyncio.get_running_loop().time() + 2
            await ws.send(self.relay.token)
            await ws.send(b'test')
            self.assertEqual(await asyncio.wait_for(ws.recv(), 3), b'fixture:test')
            with self.assertRaises(websockets.ConnectionClosed):
                await asyncio.wait_for(ws.recv(), 4)

    async def test_expiry_cancels_slow_upstream_connect(self):
        from unittest.mock import patch
        original = asyncio.open_unix_connection
        connected = asyncio.Event()

        async def delayed_open(*args, **kwargs):
            await asyncio.sleep(.8)
            result = await original(*args, **kwargs)
            connected.set()
            return result

        self.relay.deadline = asyncio.get_running_loop().time() + .3
        with patch('synthetic_lan_relay.asyncio.open_unix_connection', delayed_open):
            async with await self.connect() as ws:
                await ws.send(self.relay.token)
                await ws.send(b'after-expiry')
                with self.assertRaises(websockets.ConnectionClosed):
                    await asyncio.wait_for(ws.recv(), 1.5)
            await asyncio.sleep(.9)
        self.assertFalse(connected.is_set(), 'expired relay connected upstream')

if __name__ == '__main__':
    unittest.main()
