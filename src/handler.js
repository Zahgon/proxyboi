/**
 * Port of `src/handler.rs`.
 *
 * The proxying rules, all verified against the Rust binary:
 *
 *   - the upstream URL's own path is **discarded**; only its scheme and
 *     authority are used, and the client's request target is spliced in;
 *   - `Forwarded`, `X-Forwarded-*` and `Via` are *replaced* on the upstream
 *     request, while `--response-header` values are *appended* to the response;
 *   - `Connection` and `Transfer-Encoding` are stripped from the upstream
 *     response, and `Content-Length` is recomputed from the buffered body;
 *   - request and response bodies are buffered whole with actix's 256 KiB
 *     limit, yielding `413` and `500` respectively when exceeded;
 *   - a failed upstream request logs two ERROR lines and returns a bare `500`
 *     with an empty body, and emits no INFO line at all.
 */

import { connectionInfo } from "./connection-info.js";
import { ProxyboiError, UNKNOWN_INTERNAL_ERROR } from "./error.js";
import { ForwardedHeader } from "./forwarded-header.js";
import { HeaderMap } from "./header-map.js";
import {
	error,
	info,
	logIncomingRequest,
	logOutgoingResponse,
	logUpstreamRequest,
	logUpstreamResponse,
} from "./logging.js";
import { statusReason } from "./status-reasons.js";
import { BODY_LIMIT, sendUpstreamRequest } from "./upstream.js";

const PAYLOAD_TOO_LARGE_BODY = "A payload reached size limit.";

/** Headers actix drops when copying the upstream response to the client. */
const STRIPPED_RESPONSE_HEADERS = new Set(["connection", "transfer-encoding"]);

/**
 * Statuses for which actix's HTTP/1 encoder emits no `Content-Length` at all:
 * `100`, `102` and `204` force the body size to `None`, and `101` sets its
 * `skip_len` flag. RFC 7230 §3.3.2 forbids the header on `204` in any case.
 */
const NO_CONTENT_LENGTH_STATUSES = new Set([100, 101, 102, 204]);

/**
 * @param {Date} [now]
 * @returns {string}
 */
function httpDate(now = new Date()) {
	return now.toUTCString();
}

/**
 * @typedef {{ overflow: true } | { overflow: false; body: Buffer }} RequestBody
 */

/**
 * Buffer the request body, refusing anything over actix's `web::Bytes` limit.
 *
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<RequestBody>}
 */
function readRequestBody(req) {
	return new Promise((resolve, reject) => {
		/** @type {Buffer[]} */
		const chunks = [];
		let received = 0;
		let settled = false;

		req.on("data", (chunk) => {
			if (settled) return;
			received += chunk.length;
			if (received > BODY_LIMIT) {
				settled = true;
				resolve({ overflow: true });
				return;
			}
			chunks.push(chunk);
		});

		req.on("end", () => {
			if (settled) return;
			settled = true;
			resolve({ overflow: false, body: Buffer.concat(chunks) });
		});

		req.on("error", (err) => {
			if (settled) return;
			settled = true;
			reject(err);
		});
	});
}

/**
 * Write a response without letting Node inject headers of its own.
 *
 * actix emits neither `Connection` nor a `Date` of its own making, so both of
 * Node's automatic headers are suppressed and every header is supplied here.
 *
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {string[]} headers flat `[name, value, ...]` list
 * @param {Buffer | string} body
 */
function writeResponse(res, status, headers, body) {
	res.sendDate = false;
	res.removeHeader("connection");
	res.writeHead(status, statusReason(status), headers);
	res.end(body);
}

/**
 * Render the upstream URL the way Rust's `Url` would after `set_path` and
 * `set_query`, i.e. the upstream's scheme and authority with the client's
 * request target substituted wholesale.
 *
 * @param {URL} upstream
 * @param {string} target
 * @returns {string}
 */
function upstreamUrlFor(upstream, target) {
	const credentials =
		upstream.username === ""
			? ""
			: `${upstream.username}${upstream.password === "" ? "" : `:${upstream.password}`}@`;

	return `${upstream.protocol}//${credentials}${upstream.host}${target}`;
}

/**
 * Build the request handler.
 *
 * @param {object} params
 * @param {import("./args.js").CliArgs} params.args
 * @param {boolean} params.isTls whether this listener terminates TLS
 * @returns {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<void>}
 */
export function createHandler({ args, isTls }) {
	return async function forward(req, res) {
		/** @type {RequestBody} */
		let requestBody;
		try {
			requestBody = await readRequestBody(req);
		} catch {
			// The client vanished mid-upload; there is nothing left to reply to.
			return;
		}

		if (requestBody.overflow) {
			writeResponse(
				res,
				413,
				[
					"content-length",
					String(Buffer.byteLength(PAYLOAD_TOO_LARGE_BODY)),
					"content-type",
					"text/plain; charset=utf-8",
					"date",
					httpDate(),
				],
				PAYLOAD_TOO_LARGE_BODY,
			);
			return;
		}

		const body = requestBody.body;
		const connection = connectionInfo(req, isTls);
		const method = req.method ?? "GET";
		const target = req.url ?? "/";
		const upstreamUrlText = upstreamUrlFor(args.upstream, target);

		const incomingHeaders = HeaderMap.fromRawHeaders(req.rawHeaders);

		const incomingLog = logIncomingRequest({
			method,
			target,
			httpVersion: req.httpVersion,
			remote: connection.realipRemoteAddr,
			headers: incomingHeaders,
			verbose: args.verbose,
		});

		const forwarded = ForwardedHeader.fromInfo(
			connection.peerIp,
			args.listen.ip,
			incomingHeaders.get("forwarded") ?? "",
			connection.host,
			connection.scheme,
		).toString();

		const proxyVia = `HTTP/${req.httpVersion} proxyboi`;
		const existingVia = incomingHeaders.get("via");
		const via =
			existingVia === undefined
				? proxyVia
				: `${existingVia}, ${proxyVia}`;

		const existingForwardedFor = incomingHeaders.get("x-forwarded-for");
		const forwardedFor =
			existingForwardedFor === undefined
				? connection.peerIp
				: `${existingForwardedFor}, ${connection.peerIp}`;

		const upstreamHeaders = HeaderMap.fromRawHeaders(req.rawHeaders);
		// The body is always forwarded with an explicit length, so any inbound
		// chunked framing must not leak into the upstream request.
		upstreamHeaders.delete("transfer-encoding");
		upstreamHeaders.insert("forwarded", forwarded);
		upstreamHeaders.insert("x-forwarded-proto", connection.scheme);
		upstreamHeaders.insert("x-forwarded-host", connection.host);
		upstreamHeaders.insert("x-forwarded-for", forwardedFor);
		upstreamHeaders.insert("via", via);

		for (const extra of args.upstreamHeaders) {
			for (const [name, value] of extra) {
				upstreamHeaders.insert(name, value);
			}
		}

		const upstreamRequestLog = logUpstreamRequest({
			method,
			url: upstreamUrlText,
			headers: upstreamHeaders,
			verbose: args.verbose,
		});

		// awc stamps these on just before the request goes out, i.e. after the
		// log block above has been rendered.
		upstreamHeaders.insert("content-length", String(body.length));
		upstreamHeaders.insert("date", httpDate());

		/** @type {import("./upstream.js").UpstreamResponse} */
		let upstreamResponse;
		try {
			upstreamResponse = await sendUpstreamRequest({
				url: args.upstream,
				path: target,
				method,
				headers: upstreamHeaders.toOutgoingHeaders(),
				body,
				timeoutSeconds: args.timeout,
				insecure: args.insecure,
			});
		} catch (err) {
			error(UNKNOWN_INTERNAL_ERROR);
			error(
				`Internal Server Error: ${err instanceof ProxyboiError ? err.debugRepr : String(err)}`,
			);
			writeResponse(
				res,
				500,
				["content-length", "0", "date", httpDate()],
				"",
			);
			return;
		}

		const upstreamResponseHeaders = HeaderMap.fromRawHeaders(
			upstreamResponse.rawHeaders,
		);

		const upstreamResponseLog = logUpstreamResponse({
			status: upstreamResponse.status,
			httpVersion: upstreamResponse.httpVersion,
			url: upstreamUrlText,
			headers: upstreamResponseHeaders,
			verbose: args.verbose,
		});

		const outgoingHeaders = new HeaderMap();
		for (const [name, value] of upstreamResponseHeaders) {
			if (STRIPPED_RESPONSE_HEADERS.has(name)) continue;
			outgoingHeaders.append(name, value);
		}
		for (const extra of args.responseHeaders) {
			for (const [name, value] of extra) {
				outgoingHeaders.append(name, value);
			}
		}

		const outgoingLog = logOutgoingResponse({
			status: upstreamResponse.status,
			remote: connection.realipRemoteAddr,
			headers: outgoingHeaders,
			verbose: args.verbose,
		});

		// The encoder always leads with the recomputed length and the date, then
		// emits the remaining headers in map order.
		const wire = NO_CONTENT_LENGTH_STATUSES.has(upstreamResponse.status)
			? []
			: ["content-length", String(upstreamResponse.body.length)];
		wire.push("date", outgoingHeaders.get("date") ?? httpDate());
		for (const [name, value] of outgoingHeaders) {
			if (name === "content-length" || name === "date") continue;
			wire.push(name, value);
		}

		writeResponse(
			res,
			upstreamResponse.status,
			wire,
			upstreamResponse.body,
		);

		info(
			`${incomingLog}\n${upstreamRequestLog}\n${upstreamResponseLog}\n${outgoingLog}`,
		);
	};
}
