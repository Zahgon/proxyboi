import assert from "node:assert/strict";
import { constants } from "node:os";
import { describe, it } from "node:test";

import {
	ProxyboiError,
	UNKNOWN_INTERNAL_ERROR,
	formatIoError,
} from "../src/error.js";

const { errno } = constants;

/**
 * @param {string} message
 * @param {Record<string, unknown>} extras
 * @returns {NodeJS.ErrnoException}
 */
function ioError(message, extras) {
	return Object.assign(new Error(message), extras);
}

describe("formatIoError", () => {
	it("renders a known errno the way std::io::Error does", () => {
		assert.equal(
			formatIoError(
				ioError("connect ECONNREFUSED", { code: "ECONNREFUSED" }),
			),
			`Os { code: ${errno.ECONNREFUSED}, kind: ConnectionRefused, message: "Connection refused" }`,
		);
		assert.equal(
			formatIoError(ioError("listen EADDRINUSE", { code: "EADDRINUSE" })),
			`Os { code: ${errno.EADDRINUSE}, kind: AddrInUse, message: "Address already in use" }`,
		);
		assert.equal(
			formatIoError(ioError("read ECONNRESET", { code: "ECONNRESET" })),
			`Os { code: ${errno.ECONNRESET}, kind: ConnectionReset, message: "Connection reset by peer" }`,
		);
	});

	it("covers the whole mapped errno table", () => {
		const codes = /** @type {Array<[keyof typeof errno, string]>} */ ([
			["ECONNABORTED", "ConnectionAborted"],
			["EHOSTUNREACH", "HostUnreachable"],
			["ENETUNREACH", "NetworkUnreachable"],
			["EADDRNOTAVAIL", "AddrNotAvailable"],
			["EACCES", "PermissionDenied"],
			["EPIPE", "BrokenPipe"],
			["ETIMEDOUT", "TimedOut"],
		]);

		for (const [code, kind] of codes) {
			const rendered = formatIoError(ioError("boom", { code }));
			assert.match(rendered, new RegExp(`kind: ${kind},`), code);
			assert.match(
				rendered,
				new RegExp(`^Os \\{ code: ${errno[code]}, `),
				code,
			);
		}
	});

	it("falls back to Uncategorized for unmapped codes", () => {
		assert.equal(
			formatIoError(ioError("weird", { code: "EWEIRD", errno: -9999 })),
			'Os { code: 9999, kind: Uncategorized, message: "weird" }',
		);
	});

	it("uses code 0 when the error carries no errno at all", () => {
		assert.equal(
			formatIoError(ioError("boom", {})),
			'Os { code: 0, kind: Uncategorized, message: "boom" }',
		);
	});
});

describe("ProxyboiError", () => {
	it("always renders the same client-facing message", () => {
		const err = new ProxyboiError("Whatever(1)");

		assert.equal(UNKNOWN_INTERNAL_ERROR, "Unknown Internal Error");
		assert.equal(err.message, UNKNOWN_INTERNAL_ERROR);
		assert.equal(err.name, "ProxyboiError");
		assert.equal(err.debugRepr, "Whatever(1)");
		assert.ok(err instanceof Error);
	});

	it("keeps the originating error as its cause", () => {
		const cause = ioError("connect ECONNREFUSED", { code: "ECONNREFUSED" });
		assert.equal(ProxyboiError.sendRequest(cause).cause, cause);
	});
});

describe("ProxyboiError.sendRequest", () => {
	it("reports a connect timeout", () => {
		const err = ProxyboiError.sendRequest(
			ioError("connect timed out", { proxyboiConnectTimeout: true }),
		);
		assert.equal(err.debugRepr, "SendRequestError(Connect(Timeout))");
	});

	it("reports a refused connection with the io detail", () => {
		const err = ProxyboiError.sendRequest(
			ioError("connect ECONNREFUSED", { code: "ECONNREFUSED" }),
		);
		assert.equal(
			err.debugRepr,
			`SendRequestError(Connect(Io(Os { code: ${errno.ECONNREFUSED}, kind: ConnectionRefused, message: "Connection refused" })))`,
		);
	});

	it("reports a dropped connection as Disconnected", () => {
		for (const extras of [{ code: "ECONNRESET" }, { code: "EPIPE" }, {}]) {
			const err = ProxyboiError.sendRequest(
				ioError("socket hang up", extras),
			);
			assert.equal(
				err.debugRepr,
				"SendRequestError(Connect(Disconnected))",
			);
		}
	});

	it("reports a resolver failure with the queried hostname", () => {
		const err = ProxyboiError.sendRequest(
			ioError("getaddrinfo ENOTFOUND nope.invalid", {
				code: "ENOTFOUND",
				hostname: "nope.invalid",
			}),
		);
		assert.equal(
			err.debugRepr,
			"SendRequestError(Connect(Resolver(ResolveError { kind: NoRecordsFound { query: nope.invalid } })))",
		);
	});

	it("covers every resolver error code", () => {
		for (const code of [
			"ENOTFOUND",
			"EAI_AGAIN",
			"EAI_NODATA",
			"EAI_FAIL",
		]) {
			const err = ProxyboiError.sendRequest(ioError("dns", { code }));
			assert.match(err.debugRepr, /Connect\(Resolver\(/, code);
			assert.match(err.debugRepr, /query: unknown/, code);
		}
	});
});

describe("ProxyboiError payload failures", () => {
	it("reports an over-large body", () => {
		assert.equal(
			ProxyboiError.payloadOverflow().debugRepr,
			"PayloadError(Overflow)",
		);
	});

	it("reports a truncated body with the io detail", () => {
		const err = ProxyboiError.payloadIncomplete(
			ioError("socket hang up", { code: "ECONNRESET" }),
		);
		assert.equal(
			err.debugRepr,
			`PayloadError(Io(Some(Os { code: ${errno.ECONNRESET}, kind: ConnectionReset, message: "Connection reset by peer" })))`,
		);
	});
});
