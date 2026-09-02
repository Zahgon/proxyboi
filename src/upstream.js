/**
 * Upstream HTTP client, standing in for `awc`.
 *
 * Behavioural contract taken from the Rust original:
 *
 *   - `--timeout` is a **connection** timeout ("including DNS name
 *     resolution"), not a total-request deadline. We therefore arm the timer
 *     when the request is created and disarm it as soon as the socket is
 *     connected (or immediately, when a pooled socket is reused).
 *   - `.no_decompress()`: response bodies are passed through verbatim, with
 *     `Content-Encoding` intact. We never send our own `Accept-Encoding` and
 *     never decode.
 *   - Response bodies are buffered whole (`.body().await`) with actix's default
 *     256 KiB limit; exceeding it is a `PayloadError(Overflow)`.
 *   - `-k/--insecure` disables upstream certificate verification.
 */

import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";

import { ProxyboiError } from "./error.js";

/** actix's default `MessageBody` limit, in bytes. */
export const BODY_LIMIT = 262_144;

const httpAgent = new HttpAgent({ keepAlive: true });

/** @type {Map<boolean, HttpsAgent>} */
const httpsAgents = new Map();

/**
 * @param {boolean} insecure
 * @returns {HttpsAgent}
 */
function httpsAgentFor(insecure) {
	let agent = httpsAgents.get(insecure);
	if (agent === undefined) {
		agent = new HttpsAgent({
			keepAlive: true,
			rejectUnauthorized: !insecure,
		});
		httpsAgents.set(insecure, agent);
	}
	return agent;
}

/**
 * @typedef {object} UpstreamResponse
 * @property {number} status
 * @property {string} httpVersion
 * @property {string[]} rawHeaders flat `[name, value, ...]` list, duplicates preserved
 * @property {Buffer} body
 */

/**
 * Perform a single upstream request and buffer the whole response.
 *
 * @param {object} params
 * @param {URL} params.url upstream origin (scheme, host, port)
 * @param {string} params.path raw request target, forwarded without re-encoding
 * @param {string} params.method
 * @param {Record<string, string | string[]>} params.headers
 * @param {Buffer} params.body
 * @param {number} params.timeoutSeconds
 * @param {boolean} params.insecure
 * @returns {Promise<UpstreamResponse>}
 */
export function sendUpstreamRequest({
	url,
	path,
	method,
	headers,
	body,
	timeoutSeconds,
	insecure,
}) {
	const isTls = url.protocol === "https:";
	const send = isTls ? httpsRequest : httpRequest;
	const agent = isTls ? httpsAgentFor(insecure) : httpAgent;

	return new Promise((resolve, reject) => {
		let settled = false;

		// `setHost: false` keeps the client's original `Host` header, which the
		// Rust version forwards verbatim.
		const request = send(
			url,
			{ method, path, headers, agent, setHost: false },
			(response) => {
				/** @type {Buffer[]} */
				const chunks = [];
				let received = 0;

				response.on("data", (chunk) => {
					received += chunk.length;
					if (received > BODY_LIMIT) {
						if (settled) return;
						settled = true;
						response.destroy();
						request.destroy();
						reject(ProxyboiError.payloadOverflow());
						return;
					}
					chunks.push(chunk);
				});

				response.on("aborted", () => {
					if (settled) return;
					settled = true;
					reject(
						ProxyboiError.payloadIncomplete(
							Object.assign(new Error("socket hang up"), {
								code: "ECONNRESET",
							}),
						),
					);
				});

				response.on("end", () => {
					if (settled) return;
					settled = true;
					resolve({
						status: response.statusCode ?? 0,
						httpVersion: response.httpVersion,
						rawHeaders: response.rawHeaders,
						body: Buffer.concat(chunks),
					});
				});
			},
		);

		// Connection timeout: armed now so that DNS resolution counts towards it.
		const expire = () => {
			if (settled) return;
			settled = true;
			const err = Object.assign(new Error("connect timed out"), {
				proxyboiConnectTimeout: true,
			});
			request.destroy(err);
			reject(ProxyboiError.sendRequest(err));
		};

		const connectDeadline = Date.now() + timeoutSeconds * 1000;
		const connectTimer = setTimeout(expire, timeoutSeconds * 1000);
		const disarm = () => clearTimeout(connectTimer);

		request.on("socket", (socket) => {
			if (!socket.connecting) {
				disarm();
				return;
			}

			// actix wraps the connect future in `tokio::time::timeout`, which
			// polls the future once and only then checks the deadline. With
			// `--timeout 0` the deadline has already passed by that point, so a
			// connection still in progress is abandoned rather than waited on.
			if (Date.now() >= connectDeadline) {
				disarm();
				expire();
				return;
			}

			socket.once("connect", disarm);
		});

		request.on("error", (err) => {
			disarm();
			if (settled) return;
			settled = true;
			reject(
				ProxyboiError.sendRequest(
					/** @type {NodeJS.ErrnoException} */ (err),
				),
			);
		});

		request.on("response", disarm);

		/**
		 * `awc` has no notion of interim responses: it hands the first message
		 * off the wire to the caller, so a `1xx` becomes the final response.
		 * Node instead swallows them, reporting `100` as `continue` (with the
		 * status line already discarded) and the rest as `information`.
		 *
		 * @param {number} status
		 * @param {string[]} rawHeaders
		 */
		const settleInterim = (status, rawHeaders) => {
			disarm();
			if (settled) return;
			settled = true;
			request.destroy();
			resolve({
				status,
				httpVersion: "1.1",
				rawHeaders,
				body: Buffer.alloc(0),
			});
		};

		request.on("continue", () => settleInterim(100, []));
		request.on("information", (info) =>
			settleInterim(info.statusCode, info.rawHeaders),
		);

		// `awc` never emits a `Connection` header of its own. Node's agent does,
		// so suppress it unless the client's request actually carried one (which
		// the Rust version would have copied through). An `Expect` header makes
		// Node flush the head early, at which point the header is already gone
		// out and can no longer be removed.
		if (!Object.hasOwn(headers, "connection") && !request.headersSent) {
			request.removeHeader("connection");
		}

		request.end(body);
	});
}
