# proxyboi

[![CI](https://github.com/svenstaro/proxyboi/workflows/CI/badge.svg)](https://github.com/svenstaro/proxyboi/actions)
[![npm](https://img.shields.io/npm/v/proxyboi.svg)](https://www.npmjs.com/package/proxyboi)
[![license](http://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/svenstaro/proxyboi/blob/master/LICENSE)
[![Stars](https://img.shields.io/github/stars/svenstaro/proxyboi.svg)](https://github.com/svenstaro/proxyboi/stargazers)
[![Downloads](https://img.shields.io/npm/dm/proxyboi.svg)](https://www.npmjs.com/package/proxyboi)

**A super simple reverse proxy with TLS support**

This is the JavaScript port of proxyboi. It is a behaviour-compatible
reimplementation of the original Rust version and has **no runtime
dependencies** — it runs on the Node.js standard library alone.

## Installation

With [Node.js](https://nodejs.org) 20 or newer installed, use this command to
install it:

```sh
npm install --global proxyboi
```

You can also run it without installing anything:

```sh
npx proxyboi -l 0.0.0.0:8080 http://example.com
```

Or use the Docker image:

```sh
docker run -p 8080:8080 svenstaro/proxyboi -l 0.0.0.0:8080 http://example.com
```

## How to run

In order to listen for proxy requests on all local interfaces on port 8080 and proxy them to a service running at example.com, do:

    proxyboi -l 0.0.0.0:8080 http://example.com

You can also feed your TLS certificates into it:

    proxyboi -l 0.0.0.0:8080 --cert mycert.pem --key mykey.key http://example.com

You can see a detailed (and pretty!) verbose log using `-v`:

    proxyboi -l 0.0.0.0:8080 http://example.com -v

![Pretty log](pretty_log.png)

## Usage

    A super simple reverse proxy with TLS support

    Usage: proxyboi [OPTIONS] <UPSTREAM>

    Arguments:
      <UPSTREAM>  Upstream server to proxy to (eg. http://localhost:8080)

    Options:
      -l, --listen <LISTEN>
              Socket to listen on [default: 0.0.0.0:8080]
      -k, --insecure
              Allow connections against upstream proxies with invalid TLS certificates
      -q, --quiet
              Be quiet (log nothing)
      -v, --verbose
              Be verbose (log data of incoming and outgoing requests)
          --upstream-header <UPSTREAM_HEADERS>
              Additional headers to send to upstream server
          --response-header <RESPONSE_HEADERS>
              Additional response headers to send to requesting client
          --timeout <TIMEOUT>
              Connection timeout against upstream in seconds (including DNS name resolution) [default:
              5]
          --cert <TLS_CERT>
              TLS cert to use
          --key <TLS_KEY>
              TLS key to use
      -h, --help
              Print help
      -V, --version
              Print version

## Use as a library

The proxy is also usable programmatically:

```js
import { parseArgs, runServer } from "proxyboi";

const args = parseArgs(["-l", "127.0.0.1:8080", "http://example.com"]);
await runServer(args);
```

## Development

```sh
npm install
npm test          # node:test unit and end-to-end suites
npm run lint      # biome
npx tsc --noEmit  # typecheck the JSDoc annotations
```

## Porting notes

The port intentionally reproduces a number of quirks of the original Rust
implementation, including its duplicate-header ordering, its 256 KiB body
limits and a latent argument-validation bug. The small set of unavoidable
deviations is documented in [PORTING_NOTES.md](PORTING_NOTES.md).

## Releasing

This is mostly a note for me on how to release this thing:

- Make sure `CHANGELOG.md` is up to date.
- `npm version <version>` — this runs `scripts/release.mjs`, which performs the
  same substitutions the Rust project's `release.toml` did with `cargo release`:
  it stamps the version and date over the `Unreleased` / `ReleaseDate` markers,
  rewrites the `...HEAD` compare link to the new tag, and re-inserts fresh
  `Unreleased` markers after the `next-header` and `next-url` anchors.
  Commits and tags are GPG-signed, per `.npmrc`.
- `git push --follow-tags`
- Releases will automatically be deployed by GitHub Actions.
- Docker images will automatically be built by GitHub Actions.
- Update Arch package.
