import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as proxyboi from "../src/index.js";

describe("public module surface", () => {
	it("re-exports every documented entry point", () => {
		const expected = [
			"BIN_NAME",
			"BODY_LIMIT",
			"CliError",
			"CliExit",
			"DESCRIPTION",
			"ForwardedHeader",
			"HELP_TEXT",
			"HeaderMap",
			"IoOtherError",
			"ProxyboiError",
			"UNKNOWN_INTERNAL_ERROR",
			"UNKNOWN_REASON",
			"VERSION",
			"connectionInfo",
			"createHandler",
			"createProxyServer",
			"error",
			"formatIoError",
			"formatSocketAddr",
			"info",
			"initLogger",
			"loadCert",
			"loadPrivateKey",
			"localTimestamp",
			"logIncomingRequest",
			"logOutgoingResponse",
			"logUpstreamRequest",
			"logUpstreamResponse",
			"normalizeIp",
			"parseArgs",
			"parseHeader",
			"parseSocketAddr",
			"parseTimeout",
			"parseUpstreamUrl",
			"runServer",
			"sendUpstreamRequest",
			"statusReason",
			"toTrainCase",
		];

		assert.deepEqual(Object.keys(proxyboi).sort(), expected);
	});

	it("exposes the package metadata the CLI reports", () => {
		assert.equal(proxyboi.BIN_NAME, "proxyboi");
		assert.match(proxyboi.VERSION, /^\d+\.\d+\.\d+/);
		assert.equal(
			proxyboi.DESCRIPTION,
			"A super simple reverse proxy with TLS support",
		);
	});
});
