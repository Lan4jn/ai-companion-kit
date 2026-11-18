"""Loopback-only synthetic experiment. Never connect to a real login session.

No listener is started on import and this module intentionally rejects LAN binds.
The upstream must be a disposable fixture, not a browser with sensitive data.
"""
import asyncio
import hmac
import ipaddress
import logging
import secrets

from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed


class SyntheticRelay:
    def __init__(self, host, port, allowed_network, origin, upstream, ttl=30, upstream_token=None, page=None):
        if not ipaddress.ip_address(host).is_loopback:
            raise ValueError('synthetic relay requires loopback bind')
        if not 0 < ttl <= 300:
            raise ValueError('invalid TTL')
        self.host, self.port, self.network = host, port, allowed_network
        self.origin, self.upstream, self.ttl = origin, upstream, ttl
        self.upstream_token, self.page = upstream_token, page
        self.token = secrets.token_urlsafe(32)
        self.claimed = False
        self.lock = asyncio.Lock()
        self.server = None
        self.deadline = None

    async def start(self):
        self.deadline = asyncio.get_running_loop().time() + self.ttl
        # websocket handshake exceptions may include untrusted request headers.
        silent = logging.Logger('synthetic-no-records', level=logging.CRITICAL + 1)
        silent.addHandler(logging.NullHandler())
        silent.propagate = False
        async def http(connection, request):
            if self.page is not None and request.path == '/':
                response = connection.respond(200, self.page)
                response.headers['Content-Type'] = 'text/html; charset=utf-8'
                response.headers['Cache-Control'] = 'no-store'
                response.headers['Content-Security-Policy'] = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'"
                response.headers['X-Content-Type-Options'] = 'nosniff'
                return response
        self.server = await serve(self._handle, self.host, self.port, origins=[self.origin],
                                  process_request=http, compression=None, max_size=65536, open_timeout=3,
                                  logger=silent)
        self.port = self.server.sockets[0].getsockname()[1]

    async def _handle(self, ws):
        writer = None
        try:
            if not ipaddress.ip_address(ws.remote_address[0]) in self.network:
                return
            if ws.request.path != '/relay':
                return
            remaining = self.deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                return
            supplied = await asyncio.wait_for(ws.recv(), min(3, remaining))
            if not isinstance(supplied, str) or not hmac.compare_digest(supplied, self.token):
                return
            async with self.lock:
                if self.claimed or asyncio.get_running_loop().time() >= self.deadline:
                    return
                self.claimed = True
            deadline = self.deadline
            if deadline is None:
                return
            async with asyncio.timeout_at(deadline):
                reader, writer = await asyncio.open_unix_connection(self.upstream)
                if self.upstream_token is not None:
                    writer.write(self.upstream_token.encode('ascii') + b'\n')
                    await writer.drain()

            async def inbound():
                async for data in ws:
                    if not isinstance(data, bytes) or asyncio.get_running_loop().time() >= deadline:
                        return
                    writer.write(data)
                    await writer.drain()

            async def outbound():
                while data := await reader.read(65536):
                    if asyncio.get_running_loop().time() >= deadline:
                        return
                    await ws.send(data)

            tasks = [asyncio.create_task(inbound()), asyncio.create_task(outbound())]
            try:
                await asyncio.wait(tasks, timeout=max(0, self.deadline - asyncio.get_running_loop().time()),
                                   return_when=asyncio.FIRST_COMPLETED)
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
        except (OSError, ValueError, asyncio.TimeoutError, ConnectionClosed):
            pass
        finally:
            if writer is not None:
                writer.close()
                await writer.wait_closed()

    async def close(self):
        if self.server:
            self.server.close()
            await self.server.wait_closed()
