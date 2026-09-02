/**
 * Port of `src/logging.rs` plus the `simplelog` output format proxyboi
 * initialises in `main.rs`.
 *
 * Two independent time formats are involved and they are *not* the same clock:
 *
 *   - the `simplelog` line prefix uses **UTC** `%H:%M:%S`;
 *   - the "Connection from .. at .." message uses **local** time formatted as
 *     `[%d/%b/%Y:%H:%M:%S %z]` (chrono's `Local::now()`).
 *
 * Both were confirmed against the Rust binary. Likewise, `simplelog` writes
 * INFO/DEBUG/TRACE to stdout and WARN/ERROR to stderr (`TerminalMode::Mixed`).
 *
 * `main.rs` passes `ColorChoice::Auto`, so the `[LEVEL]` tag is coloured only
 * when the destination stream is a terminal. This is the one place proxyboi
 * gates colour on a TTY: the request/response dump goes through `yansi`, which
 * performs no detection and stays coloured through a pipe (see `ansi.js`).
 */

import {
	blue,
	boldBlue,
	boldCyan,
	boldGreen,
	boldMagenta,
	boldRed,
	cyan,
	green,
	underlineCyan,
	yellow,
} from "./ansi.js";
import { statusReason } from "./status-reasons.js";
import { toTrainCase } from "./train-case.js";

const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

/** Log levels in `log` crate order. */
const LEVEL_ERROR = 1;
const LEVEL_INFO = 3;

let currentLevel = LEVEL_INFO;

/**
 * Configure the global log level.
 *
 * Mirrors `main.rs`: `--quiet` drops the level to `Error`, which silences the
 * framework's startup lines as well as every per-request line.
 *
 * @param {{ quiet: boolean }} options
 */
export function initLogger({ quiet }) {
	currentLevel = quiet ? LEVEL_ERROR : LEVEL_INFO;
}

/**
 * @param {number} value
 * @param {number} width
 * @returns {string}
 */
function pad(value, width) {
	return String(value).padStart(width, "0");
}

/**
 * `simplelog`'s timestamp: UTC, `%H:%M:%S`.
 *
 * @param {Date} [now]
 * @returns {string}
 */
function logTimestamp(now = new Date()) {
	return `${pad(now.getUTCHours(), 2)}:${pad(now.getUTCMinutes(), 2)}:${pad(now.getUTCSeconds(), 2)}`;
}

/**
 * chrono's `Local::now().format("[%d/%b/%Y:%H:%M:%S %z]")`.
 *
 * @param {Date} [now]
 * @returns {string}
 */
export function localTimestamp(now = new Date()) {
	const offsetMinutes = -now.getTimezoneOffset();
	const sign = offsetMinutes < 0 ? "-" : "+";
	const absolute = Math.abs(offsetMinutes);
	const offset = `${sign}${pad(Math.floor(absolute / 60), 2)}${pad(absolute % 60, 2)}`;

	const date = `${pad(now.getDate(), 2)}/${MONTHS[now.getMonth()]}/${now.getFullYear()}`;
	const time = `${pad(now.getHours(), 2)}:${pad(now.getMinutes(), 2)}:${pad(now.getSeconds(), 2)}`;

	return `[${date}:${time} ${offset}]`;
}

/**
 * `simplelog`'s `[LEVEL] ` tag under `ColorChoice::Auto`.
 *
 * @param {string} tag
 * @param {string} code SGR foreground parameter.
 * @param {NodeJS.WriteStream} stream
 * @returns {string}
 */
export function levelTag(tag, code, stream) {
	if (!stream.isTTY) return tag;
	return `\u001b[0m\u001b[${code}m${tag}\u001b[0m`;
}

/**
 * Emit an INFO record on stdout, `simplelog` style.
 *
 * Only the first line of a multi-line message carries the prefix.
 *
 * @param {string} message
 */
export function info(message) {
	if (currentLevel < LEVEL_INFO) return;
	process.stdout.write(
		`${logTimestamp()} ${levelTag("[INFO] ", "34", process.stdout)}${message}\n`,
	);
}

/**
 * Emit an ERROR record on stderr, `simplelog` style.
 *
 * @param {string} message
 */
export function error(message) {
	if (currentLevel < LEVEL_ERROR) return;
	process.stderr.write(
		`${logTimestamp()} ${levelTag("[ERROR] ", "31", process.stderr)}${message}\n`,
	);
}

/**
 * Render a header block, one `│ Name: value` line per header.
 *
 * The Rust version formats every header first and *then* sorts the resulting
 * strings. Because each line starts with the same ANSI prefix this is
 * equivalent to sorting by the Train-Cased header name, but we keep the
 * original order of operations so any future divergence stays faithful.
 *
 * @param {(value: unknown) => string} deco decoration colour for the `│` gutter
 * @param {Iterable<[string, string]>} headers
 * @returns {string[]}
 */
function renderHeaders(deco, headers) {
	const gutter = deco("\u2502");
	/** @type {string[]} */
	const lines = [];

	for (const [name, value] of headers) {
		lines.push(`${gutter} ${cyan(toTrainCase(name))}: ${value}`);
	}

	lines.sort();
	return lines;
}

/**
 * Build the "Connection from .." line and, when verbose, the incoming-request
 * block. Corresponds to `log_incoming_request`.
 *
 * @param {object} params
 * @param {string} params.method
 * @param {string} params.target request target (path plus query)
 * @param {string} params.httpVersion
 * @param {string} params.remote
 * @param {Iterable<[string, string]>} params.headers
 * @param {boolean} params.verbose
 * @returns {string}
 */
export function logIncomingRequest({
	method,
	target,
	httpVersion,
	remote,
	headers,
	verbose,
}) {
	const connection = `Connection from ${remote} at ${localTimestamp()}`;
	if (!verbose) return connection;

	const banner = `${boldGreen("\u250c\u2500Incoming request")} from ${boldMagenta(remote)}`;
	const requestLine = `${boldGreen("\u2502")} ${green(method)} ${underlineCyan(target)} ${blue("HTTP")}/${blue(httpVersion)}`;

	return [
		connection,
		banner,
		requestLine,
		...renderHeaders(boldGreen, headers),
	].join("\n");
}

/**
 * Corresponds to `log_upstream_request`.
 *
 * @param {object} params
 * @param {string} params.method
 * @param {string} params.url
 * @param {Iterable<[string, string]>} params.headers
 * @param {boolean} params.verbose
 * @returns {string}
 */
export function logUpstreamRequest({ method, url, headers, verbose }) {
	if (!verbose) return "";

	const banner = `${boldCyan("\u250c\u2500Upstream request")} to ${yellow(url)}`;
	const requestLine = `${boldCyan("\u2502")} ${green(method)} ${underlineCyan(url)} ${blue("HTTP")}/${blue("1.1")}`;

	return [banner, requestLine, ...renderHeaders(boldCyan, headers)].join(
		"\n",
	);
}

/**
 * Corresponds to `log_upstream_response`.
 *
 * @param {object} params
 * @param {number} params.status
 * @param {string} params.httpVersion
 * @param {string} params.url
 * @param {Iterable<[string, string]>} params.headers
 * @param {boolean} params.verbose
 * @returns {string}
 */
export function logUpstreamResponse({
	status,
	httpVersion,
	url,
	headers,
	verbose,
}) {
	if (!verbose) return "";

	const banner = `${boldBlue("\u250c\u2500Upstream response")} from ${yellow(url)}`;
	const statusLine = `${boldBlue("\u2502")} ${blue("HTTP")}/${blue(httpVersion)} ${blue(status)} ${cyan(statusReason(status))}`;

	return [banner, statusLine, ...renderHeaders(boldBlue, headers)].join("\n");
}

/**
 * Corresponds to `log_outgoing_response`.
 *
 * @param {object} params
 * @param {number} params.status
 * @param {string} params.remote
 * @param {Iterable<[string, string]>} params.headers
 * @param {boolean} params.verbose
 * @returns {string}
 */
export function logOutgoingResponse({ status, remote, headers, verbose }) {
	if (!verbose) return "";

	const banner = `${boldRed("\u250c\u2500Outgoing response")} to ${boldMagenta(remote)}`;
	const statusLine = `${boldRed("\u2502")} ${blue("HTTP")}/${blue("1.1")} ${blue(status)} ${cyan(statusReason(status))}`;

	return [banner, statusLine, ...renderHeaders(boldRed, headers)].join("\n");
}
