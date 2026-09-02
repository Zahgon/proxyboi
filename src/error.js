/**
 * Port of `src/error.rs`.
 *
 * The Rust original defines three `thiserror` variants that all render to the
 * *same* string, which is what the client-facing log line shows:
 *
 *   #[error("Unknown Internal Error")] SendRequestError(..)
 *   #[error("Unknown Internal Error")] PayloadError(..)
 *   #[error("Unknown Internal Error")] Unknown(#[from] anyhow::Error)
 *
 * `ResponseError::error_response` logs `Display` (always the string above) and
 * replies with a bare `500 Internal Server Error` and an empty body. actix then
 * separately logs the `Debug` representation of the wrapped error, producing
 * two stderr lines per failure. We reproduce both lines.
 */

import { constants as osConstants } from "node:os";

const ERRNO = osConstants.errno;

const CONNECT_TIMEOUT = "Connect(Timeout)";
const CONNECT_DISCONNECTED = "Connect(Disconnected)";

/**
 * Map a libuv/POSIX error code onto the `std::io::ErrorKind` name and the
 * `strerror` message Rust prints inside `Os { .. }`.
 *
 * @type {Record<string, { kind: string; message: string; errno: number | undefined }>}
 */
const IO_ERROR_KINDS = {
	ENOENT: {
		kind: "NotFound",
		message: "No such file or directory",
		errno: ERRNO.ENOENT,
	},
	ECONNREFUSED: {
		kind: "ConnectionRefused",
		message: "Connection refused",
		errno: ERRNO.ECONNREFUSED,
	},
	ECONNRESET: {
		kind: "ConnectionReset",
		message: "Connection reset by peer",
		errno: ERRNO.ECONNRESET,
	},
	ECONNABORTED: {
		kind: "ConnectionAborted",
		message: "Software caused connection abort",
		errno: ERRNO.ECONNABORTED,
	},
	EHOSTUNREACH: {
		kind: "HostUnreachable",
		message: "No route to host",
		errno: ERRNO.EHOSTUNREACH,
	},
	ENETUNREACH: {
		kind: "NetworkUnreachable",
		message: "Network is unreachable",
		errno: ERRNO.ENETUNREACH,
	},
	EADDRINUSE: {
		kind: "AddrInUse",
		message: "Address already in use",
		errno: ERRNO.EADDRINUSE,
	},
	EADDRNOTAVAIL: {
		kind: "AddrNotAvailable",
		message: "Can't assign requested address",
		errno: ERRNO.EADDRNOTAVAIL,
	},
	EACCES: {
		kind: "PermissionDenied",
		message: "Permission denied",
		errno: ERRNO.EACCES,
	},
	EPIPE: { kind: "BrokenPipe", message: "Broken pipe", errno: ERRNO.EPIPE },
	ETIMEDOUT: {
		kind: "TimedOut",
		message: "Operation timed out",
		errno: ERRNO.ETIMEDOUT,
	},
};

/** Message rendered to the client-facing log for every internal failure. */
export const UNKNOWN_INTERNAL_ERROR = "Unknown Internal Error";

/**
 * Format a Node error as Rust would format `std::io::Error`'s `Debug`.
 *
 * @param {NodeJS.ErrnoException} err
 * @returns {string}
 */
export function formatIoError(err) {
	const code = typeof err.code === "string" ? err.code : "";
	const known = IO_ERROR_KINDS[code];

	if (known !== undefined && known.errno !== undefined) {
		return `Os { code: ${known.errno}, kind: ${known.kind}, message: "${known.message}" }`;
	}

	const errno = typeof err.errno === "number" ? Math.abs(err.errno) : 0;
	return `Os { code: ${errno}, kind: Uncategorized, message: "${err.message}" }`;
}

/**
 * One of the `std::io::Error::new(ErrorKind::Other, ..)` values `tls_utils.rs`
 * builds. `main` returns a `Result`, so Rust's `Termination` impl prints the
 * error's `Debug`: these reach stderr wrapped in `Custom { .. }` rather than as
 * the bare message.
 */
export class IoOtherError extends Error {
	/**
	 * @param {string} message
	 */
	constructor(message) {
		super(message);
		this.name = "IoOtherError";
		this.debugRepr = `Custom { kind: Other, error: ${JSON.stringify(message)} }`;
	}
}

/**
 * A failure that occurred while talking to (or reading from) the upstream.
 *
 * `debugRepr` reproduces the `{:?}` rendering actix logs on the second stderr
 * line, so that operators grepping logs see the same shapes as before.
 */
export class ProxyboiError extends Error {
	/**
	 * @param {string} debugRepr
	 * @param {{ cause?: unknown }} [options]
	 */
	constructor(debugRepr, options = {}) {
		super(UNKNOWN_INTERNAL_ERROR, options);
		this.name = "ProxyboiError";
		this.debugRepr = debugRepr;
	}

	/**
	 * The upstream request could not be sent.
	 *
	 * @param {NodeJS.ErrnoException & { proxyboiConnectTimeout?: boolean }} err
	 * @returns {ProxyboiError}
	 */
	static sendRequest(err) {
		return new ProxyboiError(`SendRequestError(${connectErrorRepr(err)})`, {
			cause: err,
		});
	}

	/**
	 * A body (request or response) exceeded actix's 256 KiB buffering limit.
	 *
	 * @returns {ProxyboiError}
	 */
	static payloadOverflow() {
		return new ProxyboiError("PayloadError(Overflow)");
	}

	/**
	 * The upstream connection died while the body was being read.
	 *
	 * @param {NodeJS.ErrnoException} err
	 * @returns {ProxyboiError}
	 */
	static payloadIncomplete(err) {
		return new ProxyboiError(
			`PayloadError(Io(Some(${formatIoError(err)})))`,
			{ cause: err },
		);
	}
}

/**
 * Render the `ConnectError` half of `SendRequestError`'s `Debug` output.
 *
 * @param {NodeJS.ErrnoException & { proxyboiConnectTimeout?: boolean }} err
 * @returns {string}
 */
function connectErrorRepr(err) {
	if (err.proxyboiConnectTimeout === true) {
		return CONNECT_TIMEOUT;
	}

	const code = typeof err.code === "string" ? err.code : "";

	if (
		code === "ENOTFOUND" ||
		code === "EAI_AGAIN" ||
		code === "EAI_NODATA" ||
		code === "EAI_FAIL"
	) {
		// The Rust build embeds trust-dns and prints its internal resolver state
		// here. That structure is not reconstructible from Node's DNS errors, so
		// we emit a structurally similar but honestly-populated stand-in.
		// See PORTING_NOTES.md ("Deliberate deviations").
		const reported = /** @type {{ hostname?: unknown }} */ (err).hostname;
		const hostname = typeof reported === "string" ? reported : "unknown";
		return `Connect(Resolver(ResolveError { kind: NoRecordsFound { query: ${hostname} } }))`;
	}

	if (
		code === "ECONNRESET" ||
		code === "EPIPE" ||
		err.message === "socket hang up"
	) {
		return CONNECT_DISCONNECTED;
	}

	return `Connect(Io(${formatIoError(err)}))`;
}
