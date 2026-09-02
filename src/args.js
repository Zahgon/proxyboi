/**
 * Port of `src/args.rs`, including a hand-rolled argument parser that
 * reproduces clap 4's user-visible surface: the exact `--help` layout, the
 * exact error wording, and the exit codes (0 for `--help`/`--version`, 2 for
 * any usage error).
 *
 * A third-party CLI library was deliberately avoided: none of them produce
 * clap's diagnostics verbatim, and matching those diagnostics is part of being
 * functionally equivalent for a tool that is driven from shell scripts.
 */

import { HeaderMap } from "./header-map.js";
import { BIN_NAME, DESCRIPTION, VERSION } from "./version.js";

/** Rendered by `--help`, and referenced by the README. */
export const HELP_TEXT = `${DESCRIPTION}

Usage: ${BIN_NAME} [OPTIONS] <UPSTREAM>

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
          Print version`;

const USAGE_WITH_OPTIONS = `Usage: ${BIN_NAME} [OPTIONS] <UPSTREAM>`;
const TRY_HELP = `For more information, try '--help'.`;

/** Signals a usage error; carries clap's full stderr text and exit code 2. */
export class CliError extends Error {
	/** @param {string} text */
	constructor(text) {
		super(text);
		this.name = "CliError";
		this.exitCode = 2;
	}
}

/** Signals `--help` / `--version`: print to stdout and exit 0. */
export class CliExit extends Error {
	/** @param {string} text */
	constructor(text) {
		super(text);
		this.name = "CliExit";
		this.exitCode = 0;
	}
}

/**
 * clap's "invalid value" diagnostic.
 *
 * @param {string} value
 * @param {string} spec argument spec as clap prints it, e.g. `--timeout <TIMEOUT>`
 * @param {string} reason
 * @returns {CliError}
 */
function invalidValue(value, spec, reason) {
	return new CliError(
		`error: invalid value '${value}' for '${spec}': ${reason}\n\n${TRY_HELP}`,
	);
}

// ---------------------------------------------------------------------------
// Value parsers
// ---------------------------------------------------------------------------

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// Visible ASCII, horizontal tab and obs-text; the same set `HeaderValue`
// accepts. Leading/trailing whitespace has already been trimmed by the caller.
const HEADER_VALUE_PATTERN = /^[\t\u0020-\u007e\u0080-\u00ff]*$/;

/**
 * Port of `parse_header`.
 *
 * Splits on **every** `:`, so `a:b:c` is rejected rather than being read as
 * `a` -> `b:c`; this matches the Rust original (and its error message).
 *
 * @param {string} header
 * @returns {HeaderMap}
 * @throws {Error} with a clap-compatible `message`
 */
export function parseHeader(header) {
	const parts = header.split(":");
	if (parts.length !== 2) {
		throw new Error("Wrong header format (see --help for format)");
	}

	const name = parts[0].trim().toLowerCase();
	const value = parts[1].trim();

	if (!HEADER_NAME_PATTERN.test(name)) {
		throw new Error("invalid HTTP header name");
	}
	if (!HEADER_VALUE_PATTERN.test(value)) {
		throw new Error("failed to parse header value");
	}

	return new HeaderMap().insert(name, value);
}

/**
 * Port of Rust's `SocketAddr: FromStr`. Requires a literal IP address and a
 * port; host names such as `localhost:8080` are rejected.
 *
 * @param {string} input
 * @returns {{ ip: string; port: number; isIpv6: boolean }}
 * @throws {Error}
 */
export function parseSocketAddr(input) {
	const syntaxError = new Error("invalid socket address syntax");

	/** @type {string} */
	let ip;
	/** @type {string} */
	let portText;
	let isIpv6 = false;

	if (input.startsWith("[")) {
		const close = input.indexOf("]:");
		if (close === -1) throw syntaxError;
		ip = input.slice(1, close);
		portText = input.slice(close + 2);
		isIpv6 = true;
		if (!isIpv6Literal(ip)) throw syntaxError;
	} else {
		const separator = input.lastIndexOf(":");
		if (separator === -1) throw syntaxError;
		ip = input.slice(0, separator);
		portText = input.slice(separator + 1);
		if (!isIpv4Literal(ip)) throw syntaxError;
	}

	if (!/^[0-9]+$/.test(portText)) throw syntaxError;
	const port = Number(portText);
	if (port > 65535) throw syntaxError;

	return { ip, port, isIpv6 };
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isIpv4Literal(value) {
	const octets = value.split(".");
	if (octets.length !== 4) return false;
	return octets.every(
		(octet) => /^[0-9]{1,3}$/.test(octet) && Number(octet) <= 255,
	);
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isIpv6Literal(value) {
	if (!/^[0-9A-Fa-f:.]+$/.test(value)) return false;
	if (!value.includes(":")) return false;
	// Delegate the fiddly grammar to the platform's own parser.
	try {
		return new URL(`http://[${value}]/`).hostname.length > 0;
	} catch {
		return false;
	}
}

/**
 * Port of `Url::parse` for the `<UPSTREAM>` positional, reproducing the
 * error strings the `url` crate produces for the cases users actually hit.
 *
 * @param {string} input
 * @returns {URL}
 * @throws {Error}
 */
export function parseUpstreamUrl(input) {
	if (!/^[A-Za-z][A-Za-z0-9+.\-]*:/.test(input)) {
		throw new Error("relative URL without a base");
	}

	try {
		return new URL(input);
	} catch {
		if (/^[A-Za-z][A-Za-z0-9+.\-]*:\/\/(?:$|[/?#])/.test(input)) {
			throw new Error("empty host");
		}
		if (
			/:\d*[^\d/?#]/.test(
				input.replace(/^[A-Za-z][A-Za-z0-9+.\-]*:\/\//, ""),
			)
		) {
			throw new Error("invalid port number");
		}
		throw new Error("invalid international domain name");
	}
}

/**
 * Port of Rust's `u64: FromStr`.
 *
 * @param {string} input
 * @returns {number}
 * @throws {Error}
 */
export function parseTimeout(input) {
	if (input.length === 0)
		throw new Error("cannot parse integer from empty string");
	if (!/^\+?[0-9]+$/.test(input))
		throw new Error("invalid digit found in string");

	const value = Number(input.replace(/^\+/, ""));
	if (!Number.isSafeInteger(value))
		throw new Error("number too large to fit in target type");

	return value;
}

// ---------------------------------------------------------------------------
// Argument parser
// ---------------------------------------------------------------------------

/**
 * @typedef {object} CliArgs
 * @property {{ ip: string; port: number; isIpv6: boolean }} listen socket to listen on
 * @property {string} listenRaw the listen socket as originally spelled
 * @property {boolean} insecure skip upstream certificate verification
 * @property {boolean} quiet log nothing
 * @property {boolean} verbose log full request/response data
 * @property {URL} upstream upstream server to proxy to
 * @property {HeaderMap[]} upstreamHeaders extra headers for the upstream request
 * @property {HeaderMap[]} responseHeaders extra headers for the client response
 * @property {number} timeout upstream connection timeout, in seconds
 * @property {string | undefined} tlsCert path to the TLS certificate
 * @property {string | undefined} tlsKey path to the TLS key
 */

/** Options that take a value, keyed by their long spelling. */
const VALUE_OPTIONS = new Map([
	["--listen", { field: "listen", spec: "--listen <LISTEN>" }],
	[
		"--upstream-header",
		{
			field: "upstreamHeaders",
			spec: "--upstream-header <UPSTREAM_HEADERS>",
		},
	],
	[
		"--response-header",
		{
			field: "responseHeaders",
			spec: "--response-header <RESPONSE_HEADERS>",
		},
	],
	["--timeout", { field: "timeout", spec: "--timeout <TIMEOUT>" }],
	["--cert", { field: "tlsCert", spec: "--cert <TLS_CERT>" }],
	["--key", { field: "tlsKey", spec: "--key <TLS_KEY>" }],
]);

/** Flags that take no value. */
const FLAGS = new Map([
	["--insecure", "insecure"],
	["--quiet", "quiet"],
	["--verbose", "verbose"],
]);

const SHORT_TO_LONG = new Map([
	["-l", "--listen"],
	["-k", "--insecure"],
	["-q", "--quiet"],
	["-v", "--verbose"],
	["-h", "--help"],
	["-V", "--version"],
]);

/**
 * Long argument names in the order clap declares them; ties in the suggestion
 * ranking are resolved in favour of the later declaration.
 */
const SUGGESTION_CANDIDATES = [
	"listen",
	"insecure",
	"quiet",
	"verbose",
	"upstream-header",
	"response-header",
	"timeout",
	"cert",
	"key",
	"help",
	"version",
];

/** Usage line clap prints instead of the short one once it has a suggestion. */
const USAGE_ALTERNATIVES = `Usage: ${BIN_NAME} <--listen <LISTEN>|--insecure|--quiet|--verbose|UPSTREAM|--upstream-header <UPSTREAM_HEADERS>|--response-header <RESPONSE_HEADERS>|--timeout <TIMEOUT>|--cert <TLS_CERT>|--key <TLS_KEY>>`;

/**
 * Jaro similarity, the basis of the `strsim` score clap ranks suggestions by.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function jaro(a, b) {
	if (a === b) return 1;
	if (a.length === 0 || b.length === 0) return 0;

	const window = Math.max(
		Math.floor(Math.max(a.length, b.length) / 2) - 1,
		0,
	);
	const matchedA = new Array(a.length).fill(false);
	const matchedB = new Array(b.length).fill(false);
	let matches = 0;

	for (let i = 0; i < a.length; i += 1) {
		const end = Math.min(i + window + 1, b.length);
		for (let j = Math.max(0, i - window); j < end; j += 1) {
			if (matchedB[j] || a[i] !== b[j]) continue;
			matchedA[i] = true;
			matchedB[j] = true;
			matches += 1;
			break;
		}
	}

	if (matches === 0) return 0;

	let transpositions = 0;
	let k = 0;
	for (let i = 0; i < a.length; i += 1) {
		if (!matchedA[i]) continue;
		while (!matchedB[k]) k += 1;
		if (a[i] !== b[k]) transpositions += 1;
		k += 1;
	}

	return (
		(matches / a.length +
			matches / b.length +
			(matches - transpositions / 2) / matches) /
		3
	);
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function jaroWinkler(a, b) {
	const score = jaro(a, b);
	let prefix = 0;
	while (
		prefix < 4 &&
		prefix < a.length &&
		prefix < b.length &&
		a[prefix] === b[prefix]
	) {
		prefix += 1;
	}
	return Math.min(score + 0.1 * prefix * (1 - score), 1);
}

/**
 * @param {string} token
 * @returns {string | undefined}
 */
function didYouMean(token) {
	if (!token.startsWith("--")) return undefined;

	const needle = token.slice(2);
	/** @type {string | undefined} */
	let best;
	let bestScore = 0.7;

	for (const candidate of SUGGESTION_CANDIDATES) {
		const score = jaroWinkler(needle, candidate);
		if (score >= bestScore) {
			bestScore = score;
			best = candidate;
		}
	}

	return best === undefined ? undefined : `--${best}`;
}

/**
 * @param {string} token
 * @returns {CliError}
 */
function unexpectedArgument(token) {
	const suggestion = didYouMean(token);
	if (suggestion !== undefined) {
		// `--help` and `--version` are exclusive, so clap renders a usage line
		// built from the suggested argument alone rather than the full list.
		const usage =
			suggestion === "--help" || suggestion === "--version"
				? `Usage: ${BIN_NAME} ${suggestion} <UPSTREAM>`
				: USAGE_ALTERNATIVES;

		return new CliError(
			`error: unexpected argument '${token}' found\n\n  tip: a similar argument exists: '${suggestion}'\n\n${usage}\n\n${TRY_HELP}`,
		);
	}

	const tip = token.startsWith("-")
		? `\n  tip: to pass '${token}' as a value, use '-- ${token}'\n`
		: "";
	return new CliError(
		`error: unexpected argument '${token}' found\n${tip}\n${USAGE_WITH_OPTIONS}\n\n${TRY_HELP}`,
	);
}

/**
 * @param {string} display
 * @returns {CliError}
 */
function duplicateArgument(display) {
	return new CliError(
		`error: the argument '${display}' cannot be used multiple times\n\n${USAGE_WITH_OPTIONS}\n\n${TRY_HELP}`,
	);
}

/**
 * Parse command line arguments.
 *
 * @param {readonly string[]} argv arguments *excluding* the program name
 * @returns {CliArgs}
 * @throws {CliError | CliExit}
 */
export function parseArgs(argv) {
	/** @type {string | undefined} */
	let listenRaw;
	let insecure = false;
	let quiet = false;
	let verbose = false;
	/** @type {string | undefined} */
	let upstreamRaw;
	/** @type {HeaderMap[]} */
	const upstreamHeaders = [];
	/** @type {HeaderMap[]} */
	const responseHeaders = [];
	/** @type {string | undefined} */
	let timeoutRaw;
	/** @type {Set<string>} */
	const seen = new Set();
	/** @type {{ ip: string; port: number; isIpv6: boolean } | undefined} */
	let listen;
	/** @type {number | undefined} */
	let timeout;
	/** @type {string | undefined} */
	let tlsCert;
	/** @type {string | undefined} */
	let tlsKey;

	/** @type {string[]} */
	const pending = [...argv];
	let noMoreOptions = false;

	while (pending.length > 0) {
		const token = /** @type {string} */ (pending.shift());

		if (!noMoreOptions && token === "--") {
			noMoreOptions = true;
			continue;
		}

		if (!noMoreOptions && token.startsWith("-") && token !== "-") {
			/** @type {string} */
			let name = token;
			/** @type {string | undefined} */
			let inlineValue;

			const equals = token.indexOf("=");
			if (token.startsWith("--") && equals !== -1) {
				name = token.slice(0, equals);
				inlineValue = token.slice(equals + 1);
			} else if (!token.startsWith("--") && token.length > 2) {
				// Expand a short flag cluster such as `-kv` or `-l1.2.3.4:80`.
				const long = SHORT_TO_LONG.get(token.slice(0, 2));
				if (long !== undefined && VALUE_OPTIONS.has(long)) {
					name = long;
					inlineValue = token.slice(2);
				} else if (long !== undefined) {
					pending.unshift(`-${token.slice(2)}`);
					name = long;
				} else {
					throw unexpectedArgument(token);
				}
			} else if (!token.startsWith("--")) {
				const long = SHORT_TO_LONG.get(token);
				if (long === undefined) throw unexpectedArgument(token);
				name = long;
			}

			if (name === "--help") throw new CliExit(HELP_TEXT);
			if (name === "--version")
				throw new CliExit(`${BIN_NAME} ${VERSION}`);

			const flagField = FLAGS.get(name);
			if (flagField !== undefined) {
				if (inlineValue !== undefined) {
					throw new CliError(
						`error: unexpected value '${inlineValue}' for '${name}' found; no more were expected\n\n${USAGE_WITH_OPTIONS}\n\n${TRY_HELP}`,
					);
				}
				if (seen.has(flagField)) throw duplicateArgument(name);
				seen.add(flagField);
				if (flagField === "insecure") insecure = true;
				else if (flagField === "quiet") quiet = true;
				else verbose = true;
				continue;
			}

			const option = VALUE_OPTIONS.get(name);
			if (option === undefined) throw unexpectedArgument(token);

			let value = inlineValue;
			if (value === undefined) {
				const next = pending[0];
				// clap refuses to consume a following token that looks like a flag.
				if (
					next === undefined ||
					(next.startsWith("-") && next !== "-")
				) {
					if (next !== undefined) throw unexpectedArgument(next);
					throw new CliError(
						`error: a value is required for '${option.spec}' but none was supplied\n\n${TRY_HELP}`,
					);
				}
				value = /** @type {string} */ (pending.shift());
			}

			if (
				option.field !== "upstreamHeaders" &&
				option.field !== "responseHeaders"
			) {
				if (seen.has(option.field)) {
					throw duplicateArgument(option.spec);
				}
				seen.add(option.field);
			}

			switch (option.field) {
				case "listen":
					listenRaw = value;
					listen = parseSocketAddrOrFail(value);
					break;
				case "timeout":
					timeoutRaw = value;
					timeout = parseTimeoutOrFail(value);
					break;
				case "tlsCert":
					tlsCert = value;
					break;
				case "tlsKey":
					tlsKey = value;
					break;
				case "upstreamHeaders":
					upstreamHeaders.push(parseHeaderOrFail(value, option.spec));
					break;
				case "responseHeaders":
					responseHeaders.push(parseHeaderOrFail(value, option.spec));
					break;
				default:
					throw unexpectedArgument(token);
			}
			continue;
		}

		if (upstreamRaw !== undefined) throw unexpectedArgument(token);
		upstreamRaw = token;
	}

	if (upstreamRaw === undefined) {
		throw new CliError(
			`error: the following required arguments were not provided:\n  <UPSTREAM>\n\nUsage: ${BIN_NAME} <UPSTREAM>\n\n${TRY_HELP}`,
		);
	}

	/** @type {URL} */
	let upstream;
	try {
		upstream = parseUpstreamUrl(upstreamRaw);
	} catch (err) {
		throw invalidValue(
			upstreamRaw,
			"<UPSTREAM>",
			/** @type {Error} */ (err).message,
		);
	}

	const listenText = listenRaw ?? "0.0.0.0:8080";
	const timeoutText = timeoutRaw ?? "5";

	return {
		listen: listen ?? parseSocketAddrOrFail(listenText),
		listenRaw: listenText,
		insecure,
		quiet,
		verbose,
		upstream,
		upstreamHeaders,
		responseHeaders,
		timeout: timeout ?? parseTimeoutOrFail(timeoutText),
		tlsCert,
		tlsKey,
	};
}

/**
 * @param {string} value
 * @param {string} spec
 * @returns {HeaderMap}
 */
function parseHeaderOrFail(value, spec) {
	try {
		return parseHeader(value);
	} catch (err) {
		throw invalidValue(value, spec, /** @type {Error} */ (err).message);
	}
}

/**
 * @param {string} value
 * @returns {{ ip: string; port: number; isIpv6: boolean }}
 */
function parseSocketAddrOrFail(value) {
	try {
		return parseSocketAddr(value);
	} catch (err) {
		throw invalidValue(
			value,
			"--listen <LISTEN>",
			/** @type {Error} */ (err).message,
		);
	}
}

/**
 * @param {string} value
 * @returns {number}
 */
function parseTimeoutOrFail(value) {
	try {
		return parseTimeout(value);
	} catch (err) {
		throw invalidValue(
			value,
			"--timeout <TIMEOUT>",
			/** @type {Error} */ (err).message,
		);
	}
}
