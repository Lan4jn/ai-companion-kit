# Synthetic single-use RFB broker

This is an isolated experiment, not an account-login or production handoff service.
The launcher emits `SOCKET=` and `TOKEN=` on stdout. A local client connects to
the Unix socket, writes the ASCII token plus newline, then speaks RFB. The first
valid claimant consumes the grant atomically. Disconnect or the absolute handoff
deadline stops the broker and tears down the synthetic session. Invalid tokens do
not consume the grant. Both the broker and Xvnc use Unix sockets, not TCP.

The token is a bearer secret: stdout and the enclosing mode-0700 directory must
remain private. A privileged host process or the synthetic UID can bypass the
broker by opening the underlying Xvnc Unix socket; they are trusted in this
prototype. No authenticated remote transport, restricted SSH broker, real
browser-session transfer, real account, human identity proof, or production
integration is provided. Do not expose this endpoint or reuse the fixture for a
real account. Cleanup under forced SIGKILL or host failure is not guaranteed.
