# Synthetic web handoff proof — not production

Run from this directory as root in an environment permitting `unshare`:

```
python3 test/synthetic_web_e2e_test.py
python3 -m unittest test.synthetic_lan_relay_test test.synthetic_rfb_broker_test test.isolated_login_prototype_test -v
```

Requires Xvnc, openbox, xauth, ip, unshare, Python websockets 15, the installed Playwright Chromium and Node playwright-core. The end-to-end probe creates a disposable network namespace with loopback only; the prototype creates another network/mount namespace, random unprivileged UID, synthetic kiosk data page, Unix RFB socket and single-use broker. A loopback-only HTTP/WebSocket relay connects the browser viewer to that broker using its separate private token. The browser is Playwright automated at 390x844 with mouse or emulated touch, not a physical phone or human. No real account, secrets or production browser is used; no LAN listener or service restart.

The synthetic page turns red to green only after a trusted pointer release; its random exact window title triggers the fixed synthetic fixture import. The probe verifies visual update, fixture import before disconnect, wrong Origin and token rejection, concurrent first claims (one actual RFB banner), replay while active, disconnect teardown and broker socket removal. The separate unit tests cover expiry and broker race behavior. A browser rendering pixel can include a software cursor, so read a pixel away from the click. A rendered frame may precede the title polling/import; keep the client open until verification.

The viewer supports ASCII keyboard input and basic editing keys in this synthetic setup. Non-ASCII committed text is rejected with an explicit warning; Chinese is **not supported**. RFB Unicode keysyms did not work with the tested Xvnc/Chromium combination; a Ctrl+Shift+U Unicode-entry experiment also failed. The IME-ordering tests use synthetic browser composition events, not a real phone IME; they check that rejected Chinese leaves the remote field unchanged. No clipboard is read or used as a workaround.

Limitations: this is not integrated into `/login` or Douyin, has no real session export, physical phone, verified Chinese/IME input, scrolling or multi-touch; viewer only implements a small raw RFB subset. It is not a production-ready remote desktop or LAN service. The simple relay/HTML is intentionally loopback only, with no TLS and no user-facing grant issuance/revocation UI. Origin and bearer token are not sufficient against a malicious same-UID/privileged host process, which can access the underlying socket. Real deployment needs a dedicated security and session-lifecycle design, authentication and CSRF/origin controls, bounded resource/backpressure, cleanup, accessibility, input support, and explicit validation of the exact live browser session; do not expose this proof to LAN as-is.
