# Porting notes

This document records how the JavaScript port relates to the original Rust
implementation of proxyboi: what was mapped onto what, which quirks were
reproduced deliberately, and where the port unavoidably differs.

Everything below was established empirically by running the Rust binary
(built with `debug-assertions` off) side by side with this implementation and
diffing response bytes, stdout, stderr and exit codes.

## Dependency mapping

| Rust | JavaScript |
| --- | --- |
| `clap` 4 (derive) | hand-written parser in `src/args.js` |
| `actix-web` 3 server | `node:http` / `node:https` + `node:cluster` |
| `awc` client | `node:http` / `node:https` `request()` |
| `rustls` / `webpki` | Node's built-in TLS stack |
| `simplelog` + `log` | `src/logging.js` |
| `yansi` | `src/ansi.js` |
| `Inflector::to_train_case` | `src/train-case.js` |
| `thiserror` / `anyhow` | `src/error.js` |
| `url::Url` | `URL` (WHATWG) |
| `chrono` | `Date` + `Intl`-free manual formatting |

The port has **zero runtime dependencies**. `@biomejs/biome` is the only
development dependency.

## Deliberately reproduced quirks

These are things a "clean" rewrite would have fixed. They are reproduced
because the goal is functional equivalence with the source.

### The upstream path is discarded

`handler.rs` does `new_url.set_path(req.uri().path())` on a clone of the
upstream URL, which *replaces* rather than *prefixes*. Running
`proxyboi http://backend/api/v1` and requesting `/users` therefore proxies to
`http://backend/users`, not `http://backend/api/v1/users`. `src/handler.js`
does the same.

### `--cert` does not actually require `--key`

`args.rs` declares `#[clap(requires = "tls-key")]` on `--cert` (and
`requires = "tls-cert"` on `--key`), but clap 4 derives argument IDs from the
*field* names, which are `tls_cert` and `tls_key`. The `requires` constraints
therefore point at IDs that do not exist. In a debug build clap panics on
this; in a release build the constraint is silently a no-op.

The observable result is that `proxyboi --cert cert.pem http://upstream`
starts successfully in **plain HTTP** mode, because `main.rs` only enables TLS
when both values are present. `src/args.js` reproduces this exactly and
`test/args.test.js` locks it in.

### actix's header-append ordering

`actix_http::header::HeaderMap` stores either a single value or a vector, and
promoting a single value to a vector puts the **new** value first:

```
vacant             -> One(new)
One(old)           -> Multi([new, old])      <-- the swap
Multi([a, b, ...]) -> Multi([a, b, ..., new])
```

proxyboi builds its response entirely out of `append` calls, so this is
directly observable on the wire:

- `--response-header x-new:n1 --response-header x-new:n2 --response-header x-new:n3`
  on a header the upstream did not send emits `n2, n1, n3`;
- an upstream sending `x-dup: u1` and `x-dup: u2`, proxied with
  `--response-header x-dup:cli1 --response-header x-dup:cli2`, emits
  `u1, u2, cli1, cli2` (the swap happens on parse and again on copy, and
  cancels out);
- an upstream sending a single `x-origin: yes`, proxied with
  `--response-header x-origin:appended`, emits `appended` *before* `yes`.

`src/header-map.js` implements the same promotion rule, so duplicate-value
ordering is identical.

### 256 KiB body limits

`CHANGELOG.md` claims the body limit was raised to 1G in 0.4.3, but the
actix-web 3 upgrade regressed it back to the framework defaults. Measured
against the Rust binary:

- a request body of exactly 262144 bytes succeeds; 262145 bytes is answered
  with `413 Payload Too Large`, `content-length: 29`,
  `content-type: text/plain; charset=utf-8` and the body
  `A payload reached size limit.` (no log line is emitted, because the handler
  never runs);
- a response body of exactly 262144 bytes succeeds; 262145 bytes produces a
  `500` and logs `PayloadError(Overflow)`.

`src/upstream.js` and `src/handler.js` enforce the same inclusive limits.

### No `Content-Length` on bodyless statuses

actix's HTTP/1 encoder overrides the computed body size for a fixed set of
statuses: `100 Continue`, `102 Processing` and `204 No Content` force it to
`None`, and `101 Switching Protocols` sets the encoder's `skip_len` flag. For
all four, no `Content-Length` reaches the wire. Every other status — including
`205 Reset Content` and `304 Not Modified`, which are also bodyless — *does*
get an explicit `content-length: 0`.

This matters because emitting `Content-Length` on a `204` violates RFC 7230
§3.3.2. `src/handler.js` applies the same rule, so the port is byte-identical
to the original here (and, as it happens, correct on `204`).

### `keep-alive` is not stripped

The handler filters only `connection` and `transfer-encoding` out of the
upstream response. An upstream `keep-alive: timeout=5` is therefore copied
through to the client. This is reproduced.

### Colours are unconditional

`yansi`'s default configuration performs no TTY or environment detection, so
proxyboi emits ANSI escapes even when its output is piped to a file, and it
ignores `NO_COLOR`. `src/ansi.js` matches this, including the exact byte
shapes (attributes before the colour, e.g. `\x1b[1;32m`, `\x1b[4;36m`).

### `simplelog` prefix details

The log prefix is emitted on the first line of a multi-line message only, uses
**UTC** for its `HH:MM:SS` clock, and has the exact byte layout
`HH:MM:SS \x1b[0m\x1b[34m[INFO] \x1b[0m`. `INFO` goes to stdout, `ERROR` to
stderr. `--quiet` raises the level to `Error`, which silences the actix
startup lines as well. All reproduced in `src/logging.js`.

Note that the per-request `Connection from ... at ...` timestamp is formatted
with `chrono`'s **local** time (`[%d/%b/%Y:%H:%M:%S %z]`) while the log prefix
is UTC. That inconsistency is preserved.

### `realip` versus `peer`

The `Connection from` log line and the outgoing-response block use actix's
`realip_remote_addr()`, which falls back to the peer address **including the
port** (`127.0.0.1:52259`). The `Forwarded` and `X-Forwarded-For` headers use
`head().peer_addr.ip()`, which is the IP **without** a port. These are two
different values in the same request and both are reproduced.

### `Forwarded` parsing is loose

`forwarded_header.rs` finds the first `for=`, takes everything up to the next
`;`, splits on `,` and calls `.replace("for=", "")` on each part without
trimming. Malformed input is therefore passed through in surprising ways.
`src/forwarded-header.js` is a literal port, and the four unit tests from
`forwarded_header.rs` are ported verbatim in
`test/forwarded-header.test.js`.

### `Inflector`'s train-case rule

Header names are displayed in train case using `Inflector`, which breaks words
on non-alphanumeric characters, on lowercase-to-uppercase transitions **and on
digit-to-letter transitions** (but not letter-to-digit). Hence
`x-b3-traceid` becomes `X-B3-Traceid` but `x-a1b2` becomes `X-A1-B2`.
Reproduced in `src/train-case.js` with the measured vectors locked into
`test/train-case.test.js`.

### Worker model and shutdown wording

actix starts one worker per logical CPU and logs `Starting N workers` followed
by `Starting "actix-web-service-<addr>" service on <addr>`. `SIGINT` logs
`SIGINT received, exiting` and exits immediately; `SIGTERM` logs
`SIGTERM received, stopping` followed by one `Shutting down worker, N connections`
line per worker (or `Graceful worker shutdown, N connections` when a worker
still has traffic). `src/server.js` reproduces this with `node:cluster`,
including the detail that a failed bind exits with code **1** and prints
`Error: Os { code: 48, kind: AddrInUse, message: "Address already in use" }`
to stderr *before* any log lines are produced.

### clap's argument-parsing order and diagnostics

clap validates each value the moment it parses it, so `proxyboi -l nonsense`
reports the bad `--listen` value rather than the missing `<UPSTREAM>`.
`src/args.js` therefore parses `--listen` and `--timeout` inside the argument
loop instead of after it.

Every argument except `--upstream-header` and `--response-header` is
single-valued, and clap rejects a second occurrence with
`error: the argument '<display>' cannot be used multiple times`. The display
name is always the long form (`-v -v` reports `'--verbose'`) and includes the
value placeholder for options (`'--timeout <TIMEOUT>'`).

Unknown long flags run through clap's suggestion engine, which scores every
declared long name with `strsim`'s Jaro-Winkler distance, keeps everything
above `0.7`, and picks the highest score — resolving ties in favour of the
*later* declaration, which is why `--ver` suggests `--version` rather than
`--verbose`. When a suggestion exists the usage line switches to the
"one of" rendering, except for the exclusive `--help` and `--version`
arguments, which produce `Usage: proxyboi --help <UPSTREAM>`. With no
suggestion the error falls back to the `to pass '<x>' as a value, use '-- <x>'`
tip. `src/args.js` implements Jaro-Winkler directly to keep the ranking
identical.

### Error responses carry no detail

All three `ProxyboiError` variants render as `Unknown Internal Error` and the
client receives a bare `500` with `content-length: 0` and no body. Two lines
go to stderr: the rendered error, then
`Internal Server Error: <Debug of the underlying error>`.

### PEM parsing follows rustls, not intuition

`tls_utils.rs` reads its PEM through `rustls::internal::pemfile` (rustls
0.18.1). That parser scans line by line for a `BEGIN` mark, buffers until the
matching `END` mark, and base64-decodes the buffer. **A file with no marks at
all is not an error** — `extract` reaches EOF and returns `Ok(vec![])`. The
only way to get `Err` is a delimited block whose base64 does not decode.

Two consequences drive `src/tls-utils.js`:

- `--cert` pointed at a file containing no `CERTIFICATE` block yields an empty
  chain, and `load_cert`'s `"File contains an invalid certificate"` branch is
  never reached. The Rust binary **starts and binds**, then fails every
  handshake because it has nothing to present. `loadCert` therefore returns
  `""` for an empty chain and only throws when a block fails to decode.
- `load_private_key` runs `rsa_private_keys` (PKCS#1) *before*
  `pkcs8_private_keys`, so a file whose blocks are both corrupt reports the
  RSA diagnostic. It then prefers the PKCS#8 key when both parse. An
  *encrypted* PKCS#8 file matches neither mark, so it does not reach the
  `"encrypted keys not supported"` message at all — that string is only
  reachable through a corrupt plain PKCS#8 block.

The parser is reproduced line-for-line in `extractPem`. `Buffer.from(s,
"base64")` cannot be used for validation because it silently skips invalid
characters where the `base64` crate rejects them, so `decodesAsBase64`
pre-checks the payload.

These failures surface as `io::Error::new(ErrorKind::Other, msg)`, which
`Termination` renders as `Error: Custom { kind: Other, error: "<msg>" }` —
not as a bare message. `IoOtherError` in `src/error.js` carries that rendering
on a `debugRepr` property and `failFast` prefers it. A missing file surfaces
as the operating system error instead, `Error: Os { code: 2, kind: NotFound,
message: "No such file or directory" }`, which is why `ENOENT` is in the
`IO_ERROR_KINDS` table alongside `EADDRINUSE`.

## Deviations

These are the only places where behaviour differs. Each is either impossible
or actively harmful to reproduce.

### Ordering of *distinct* header names

`actix-http` 2 does not use `http::HeaderMap` (which iterates in insertion
order). It declares its own `HeaderMap` over `fxhash::FxHashMap`
(`actix-http-2.2.2/src/header/map.rs`). `FxBuildHasher` has a fixed seed, so
the order is *deterministic* — running the Rust binary five times yields a
byte-identical header order — but it is the order of hashbrown's SwissTable
probe sequence and resize history, not of insertion. Reproducing it would
mean reimplementing fxhash and hashbrown's table layout in JavaScript and
keeping that reimplementation in step with the exact insertion sequence.

This port uses insertion order instead. Header *sets*, header *values* and
duplicate-value ordering are identical; only the relative position of
unrelated names differs. RFC 7230 §3.2.2 makes the order of distinct field
names non-significant, so both orders are correct.

### `Debug` strings for transport errors

The second stderr line renders the Rust error type's `Debug` output. Common
cases are reproduced exactly (`SendRequestError(Connect(Timeout))`,
`SendRequestError(Connect(Disconnected))`, `PayloadError(Overflow)`, and
`SendRequestError(Connect(Io(Os { code: 61, kind: ConnectionRefused, ... })))`
with the platform's real errno). Two cases cannot be:

- **DNS failures.** The Rust binary prints `trust-dns` internals, including a
  `valid_until: Some(Instant { tv_sec: ..., tv_nsec: ... })` field. This port
  emits a structurally similar `Connect(Resolver(...))` string built from
  Node's DNS error.
- **TLS verification failures.** The Rust binary prints rustls/webpki
  internals such as `Custom { kind: InvalidData, error: WebPKIError(CAUsedAsEndEntity) }`.
  This port prints Node's message instead. The wire response is identical in
  both cases (`500`, `content-length: 0`, empty body).

### HTTP/2 over TLS

`bind_rustls` advertises `h2` via ALPN, but the h2 responses produced by the
actix-web 3 / rustls 0.18 combination in the source are broken: a modern curl
negotiates h2, sends the request, and the stream is reset
(`HTTP/2 stream 1 was not closed cleanly: CANCEL (err 8)`, curl exit code 92).
Only `--http1.1` works.

This port advertises `http/1.1` only. Clients transparently negotiate
HTTP/1.1 and receive a working, byte-identical response instead of a hard
failure. Reproducing a broken h2 implementation was judged to have no value.

### `101 Switching Protocols` from an upstream

For `101` the actix encoder sets `skip_len` *and* switches the body to
`BodySize::Stream`, then waits for a stream that the buffered-body handler
never produces. The Rust binary consequently writes **nothing at all** to the
client and holds the connection open until it times out.

This port forwards the `101` status line and headers (without a
`Content-Length`, matching the encoder) and closes the exchange normally.
Deliberately reproducing a deadlock was judged to have no value. `100` and
`102`, which the source handles correctly, are byte-identical.

### HTTPS upstream addressed by IP

Pointing the Rust binary at `https://127.0.0.1:port` panics the worker thread:

```
thread 'actix-rt:worker:0' panicked at actix-connect-2.0.0/src/ssl/rustls.rs:107:14:
rustls currently only handles hostname-based connections. See
https://github.com/briansmith/webpki/issues/54: InvalidDNSNameError
```

The client gets no response at all. This port connects normally and, without
`-k`, returns the usual `500` for the certificate mismatch. Reproducing a
panic was judged to have no value. HTTPS upstreams addressed by hostname
behave identically in both implementations, with and without `-k`.

### `assert!` on a key file that yields no key

`load_private_key` ends with `assert!(!rsa_keys.is_empty())`. When `--key`
points at a file with no usable key — no PEM marks at all, or an encrypted
PKCS#8 key, which matches neither mark — the assertion fires:

```
thread 'main' (NNNNNN) panicked at src/tls_utils.rs:46:9:
assertion failed: !rsa_keys.is_empty()
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace
Panic in Arbiter thread.
```

The process exits **101**. This port prints
`Error: File contains no usable private key` and exits **1**. Both refuse to
serve and neither binds the listener, so no client can observe a difference;
only the operator-facing diagnostic differs. Reproducing a panic — including
its source coordinates and process id — was judged to have no value, matching
the decision taken for the HTTPS-upstream panic above.

### `Transfer-Encoding` on the upstream request

The Rust client rebuilds the upstream request from a fully buffered body and
always sends `content-length`. This port explicitly deletes any inbound
`transfer-encoding` header before forwarding, which is required to get the
same wire bytes out of `node:http`. The upstream sees the same header set
either way.

### `Connection` header on the upstream request

`awc` sends no `Connection` header at all. `node:http` adds
`Connection: keep-alive` by default, so `src/upstream.js` removes it after
constructing the request (unless the client supplied one), while keeping
socket reuse enabled. The upstream therefore receives the identical header
set.
