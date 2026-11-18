# OneBot durable recovery TLS candidate

This is disabled and not wired into startup. It authenticates only the HTTPS
recovery sender, not event ingress. Do not enable durable owner ingress on the
basis of this sender: existing OneBot WS messages have no verified server
identity and sender IDs supplied over that link are not authenticated evidence.

The current local NapCat HTTP/WS listeners are plain HTTP/WS without configured
tokens and Docker publishes them on all host interfaces. The companion connects
via loopback, but another network client can reach the published listeners
unless independently filtered. A bearer token authenticates the client to the
server, not the server to the client.

Deployment design (not performed): put an HTTPS reverse proxy on an isolated
address in front of the intended NapCat HTTP server. Provision a dedicated CA,
server certificate with the proxy DNS name in SAN, and a private key readable
only by the proxy. Bind/filter NapCat so only that proxy can reach it, including
container networks; prevent bypass of the proxy and unauthorized local clients.
Use a high-entropy NapCat access token and enforce authorization at the proxy;
protect both credentials and selector/seal keys, and restrict socket directory
to the trusted service UID. Protect the proxy-to-NapCat hop with host/container
isolation or a separately authenticated encrypted channel if it crosses hosts.
The proxy and its upstream configuration are part of the trusted computing base.

Construct `createAuthenticatedOneBotSender` with an https origin URL, a Buffer
containing the trusted CA PEM, the lowercase SHA-256 hex fingerprint of the
proxy leaf certificate, ownerId and optional accessToken. Pass that exact sender
to `startOneBotQueueBridge`. Each request checks CA, hostname and leaf pin before
HTTP bytes are sent, disallows redirects, uses a fresh TLS connection, and sends
only plain-text messages to the configured owner. Certificate rotation requires
securely updating the configured pin. A request whose outcome is unclear stays
unknown and must not be automatically retried. This does not prove delivery.

The independently callable lower-level experimental candidates still rely on
trusted callers and are not authorization boundaries. To achieve end-to-end
queue identity, separately bind incoming WebSocket events to an authenticated
connection, validate expected account identity without trusting self-reported
fields as authentication, couple evidence to the socket lifecycle and replay
policy, and test the complete isolated flow. No such ingress authentication or
production integration is claimed here.
