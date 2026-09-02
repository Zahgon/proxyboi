/**
 * Port of actix-web's `ConnectionInfo`, which proxyboi relies on to decide the
 * scheme, host and "real" remote address of an incoming request.
 *
 * Resolution order (verified against the Rust binary):
 *
 *   scheme : Forwarded[proto] -> X-Forwarded-Proto[0] -> request URI scheme -> "http"
 *   host   : Forwarded[host]  -> X-Forwarded-Host[0]  -> Host header -> URI authority -> "localhost"
 *   realip : Forwarded[for]   -> X-Forwarded-For[0]   -> peer address (**including port**)
 *
 * Note the asymmetry that proxyboi depends on: `realipRemoteAddr` falls back to
 * the peer socket address *with* its port (`127.0.0.1:52259`), whereas the
 * value appended to `Forwarded`/`X-Forwarded-For` is the bare peer IP.
 */

const UNKNOWN_ADDRESS = "unknown";

/**
 * Strip surrounding double quotes from a `Forwarded` element value.
 *
 * @param {string} value
 * @returns {string}
 */
function unquote(value) {
	return value.trim().replace(/^"/, "").replace(/"$/, "");
}

/**
 * Read the first comma-separated element of a possibly-repeated header.
 *
 * @param {string | string[] | undefined} raw
 * @returns {string | undefined}
 */
function firstElement(raw) {
	if (raw === undefined) return undefined;
	const value = Array.isArray(raw) ? raw[0] : raw;
	if (value === undefined) return undefined;
	const first = value.split(",")[0].trim();
	return first.length > 0 ? first : undefined;
}

/**
 * @typedef {object} ConnectionInfo
 * @property {string} scheme protocol the client used to reach proxyboi
 * @property {string} host host the client asked for
 * @property {string} realipRemoteAddr best-effort client address
 * @property {string} peerAddr raw peer socket address (`ip:port`)
 * @property {string} peerIp raw peer IP without the port
 */

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {boolean} isTls whether the listener terminates TLS
 * @returns {ConnectionInfo}
 */
export function connectionInfo(req, isTls) {
	/** @type {string | undefined} */
	let scheme;
	/** @type {string | undefined} */
	let host;
	/** @type {string | undefined} */
	let realip;

	const forwarded = req.headers.forwarded;
	const forwardedValues =
		forwarded === undefined
			? []
			: Array.isArray(forwarded)
				? forwarded
				: [forwarded];

	for (const header of forwardedValues) {
		for (const group of header.split(";")) {
			for (const pair of group.split(",")) {
				const separator = pair.indexOf("=");
				if (separator === -1) continue;

				const name = pair.slice(0, separator).trim().toLowerCase();
				const value = unquote(pair.slice(separator + 1));
				if (value.length === 0) continue;

				// Only the first occurrence of each directive wins.
				if (name === "for" && realip === undefined) realip = value;
				else if (name === "proto" && scheme === undefined)
					scheme = value;
				else if (name === "host" && host === undefined) host = value;
			}
		}
	}

	scheme ??=
		firstElement(req.headers["x-forwarded-proto"]) ??
		(isTls ? "https" : "http");
	host ??=
		firstElement(req.headers["x-forwarded-host"]) ??
		(typeof req.headers.host === "string" ? req.headers.host : undefined) ??
		"localhost";

	const peerIp = normalizeIp(req.socket.remoteAddress);
	const peerPort = req.socket.remotePort;
	const peerAddr =
		peerPort === undefined ? peerIp : formatSocketAddr(peerIp, peerPort);

	realip ??= firstElement(req.headers["x-forwarded-for"]) ?? peerAddr;

	return { scheme, host, realipRemoteAddr: realip, peerAddr, peerIp };
}

/**
 * Node reports IPv4 peers of a dual-stack listener as `::ffff:127.0.0.1`;
 * Rust's `SocketAddr` reports the plain IPv4 form. Normalise to match.
 *
 * @param {string | undefined} address
 * @returns {string}
 */
export function normalizeIp(address) {
	if (address === undefined || address.length === 0) return UNKNOWN_ADDRESS;
	if (address.startsWith("::ffff:") && address.includes(".")) {
		return address.slice("::ffff:".length);
	}
	return address;
}

/**
 * Render an `ip:port` pair the way Rust's `SocketAddr` `Display` does, i.e.
 * bracketing IPv6 addresses.
 *
 * @param {string} ip
 * @param {number} port
 * @returns {string}
 */
export function formatSocketAddr(ip, port) {
	return ip.includes(":") ? `[${ip}]:${port}` : `${ip}:${port}`;
}
