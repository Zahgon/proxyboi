import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
	error,
	info,
	initLogger,
	localTimestamp,
	logIncomingRequest,
	logOutgoingResponse,
	logUpstreamRequest,
	logUpstreamResponse,
} from "../src/logging.js";

const ESC = "\u001b";

/**
 * @param {() => void} body
 * @param {{ tty?: boolean }} [options]
 * @returns {{ stdout: string, stderr: string }}
 */
function capture(body, { tty = false } = {}) {
	const originalOut = process.stdout.write;
	const originalErr = process.stderr.write;
	const originalOutTty = process.stdout.isTTY;
	const originalErrTty = process.stderr.isTTY;
	let stdout = "";
	let stderr = "";

	process.stdout.write = /** @type {any} */ (
		(/** @type {string} */ chunk) => {
			stdout += chunk;
			return true;
		}
	);
	process.stderr.write = /** @type {any} */ (
		(/** @type {string} */ chunk) => {
			stderr += chunk;
			return true;
		}
	);
	process.stdout.isTTY = tty;
	process.stderr.isTTY = tty;

	try {
		body();
	} finally {
		process.stdout.write = originalOut;
		process.stderr.write = originalErr;
		process.stdout.isTTY = originalOutTty;
		process.stderr.isTTY = originalErrTty;
	}

	return { stdout, stderr };
}

afterEach(() => {
	initLogger({ quiet: false });
});

describe("simplelog record format", () => {
	it("writes INFO to stdout with a UTC prefix", () => {
		initLogger({ quiet: false });
		const { stdout, stderr } = capture(() => info("hello"), { tty: true });

		assert.equal(stderr, "");
		assert.match(
			stdout,
			new RegExp(
				`^\\d{2}:\\d{2}:\\d{2} ${ESC}\\[0m${ESC}\\[34m\\[INFO\\] ${ESC}\\[0mhello\\n$`,
			),
		);
	});

	it("writes ERROR to stderr", () => {
		initLogger({ quiet: false });
		const { stdout, stderr } = capture(() => error("boom"), { tty: true });

		assert.equal(stdout, "");
		assert.match(
			stderr,
			new RegExp(
				`^\\d{2}:\\d{2}:\\d{2} ${ESC}\\[0m${ESC}\\[31m\\[ERROR\\] ${ESC}\\[0mboom\\n$`,
			),
		);
	});

	it("drops the level colour when the stream is not a terminal", () => {
		initLogger({ quiet: false });
		const { stdout } = capture(() => info("hello"));
		const { stderr } = capture(() => error("boom"));

		assert.match(stdout, /^\d{2}:\d{2}:\d{2} \[INFO\] hello\n$/);
		assert.match(stderr, /^\d{2}:\d{2}:\d{2} \[ERROR\] boom\n$/);
		assert.ok(!stdout.includes(ESC));
		assert.ok(!stderr.includes(ESC));
	});

	it("prefixes only the first line of a multi-line record", () => {
		initLogger({ quiet: false });
		const { stdout } = capture(() => info("first\nsecond\nthird"));
		const lines = stdout.trimEnd().split("\n");

		assert.equal(lines.length, 3);
		assert.match(lines[0], /\[INFO\] /);
		assert.equal(lines[1], "second");
		assert.equal(lines[2], "third");
	});

	it("silences INFO but keeps ERROR when quiet", () => {
		initLogger({ quiet: true });
		const { stdout, stderr } = capture(() => {
			info("hidden");
			error("shown");
		});

		assert.equal(stdout, "");
		assert.match(stderr, /shown/);
	});
});

describe("localTimestamp", () => {
	it("renders chrono's [%d/%b/%Y:%H:%M:%S %z] layout", () => {
		const originalTz = process.env.TZ;
		try {
			process.env.TZ = "UTC";
			assert.equal(
				localTimestamp(new Date("2026-09-02T12:23:20Z")),
				"[02/Sep/2026:12:23:20 +0000]",
			);
		} finally {
			process.env.TZ = originalTz;
		}
	});

	it("renders a positive offset with minutes", () => {
		const originalTz = process.env.TZ;
		try {
			process.env.TZ = "Asia/Kolkata";
			assert.equal(
				localTimestamp(new Date("2026-09-02T06:53:20Z")),
				"[02/Sep/2026:12:23:20 +0530]",
			);
		} finally {
			process.env.TZ = originalTz;
		}
	});

	it("renders a negative offset", () => {
		const originalTz = process.env.TZ;
		try {
			process.env.TZ = "America/New_York";
			assert.equal(
				localTimestamp(new Date("2026-01-15T17:23:20Z")),
				"[15/Jan/2026:12:23:20 -0500]",
			);
		} finally {
			process.env.TZ = originalTz;
		}
	});

	it("zero-pads every field", () => {
		const originalTz = process.env.TZ;
		try {
			process.env.TZ = "UTC";
			assert.equal(
				localTimestamp(new Date("2026-01-02T03:04:05Z")),
				"[02/Jan/2026:03:04:05 +0000]",
			);
		} finally {
			process.env.TZ = originalTz;
		}
	});
});

describe("log_incoming_request", () => {
	const params = {
		method: "GET",
		target: "/users?a=b",
		httpVersion: "1.1",
		remote: "127.0.0.1:52259",
		headers: /** @type {Array<[string, string]>} */ ([
			["user-agent", "curl/8.7.1"],
			["accept", "*/*"],
			["host", "127.0.0.1:8080"],
		]),
	};

	it("emits only the connection line when not verbose", () => {
		const rendered = logIncomingRequest({ ...params, verbose: false });

		assert.match(
			rendered,
			/^Connection from 127\.0\.0\.1:52259 at \[\d{2}\/[A-Z][a-z]{2}\/\d{4}:\d{2}:\d{2}:\d{2} [+-]\d{4}\]$/,
		);
	});

	it("emits the banner, request line and sorted headers when verbose", () => {
		const lines = logIncomingRequest({ ...params, verbose: true }).split(
			"\n",
		);

		assert.equal(lines.length, 6);
		assert.match(lines[0], /^Connection from /);
		assert.equal(
			lines[1],
			`${ESC}[1;32m\u250c\u2500Incoming request${ESC}[0m from ${ESC}[1;35m127.0.0.1:52259${ESC}[0m`,
		);
		assert.equal(
			lines[2],
			`${ESC}[1;32m\u2502${ESC}[0m ${ESC}[32mGET${ESC}[0m ${ESC}[4;36m/users?a=b${ESC}[0m ${ESC}[34mHTTP${ESC}[0m/${ESC}[34m1.1${ESC}[0m`,
		);
		assert.equal(
			lines[3],
			`${ESC}[1;32m\u2502${ESC}[0m ${ESC}[36mAccept${ESC}[0m: */*`,
		);
		assert.equal(
			lines[4],
			`${ESC}[1;32m\u2502${ESC}[0m ${ESC}[36mHost${ESC}[0m: 127.0.0.1:8080`,
		);
		assert.equal(
			lines[5],
			`${ESC}[1;32m\u2502${ESC}[0m ${ESC}[36mUser-Agent${ESC}[0m: curl/8.7.1`,
		);
	});
});

describe("the remaining log blocks", () => {
	const headers = /** @type {Array<[string, string]>} */ ([
		["x-b3-traceid", "abc"],
		["content-type", "text/plain"],
	]);

	it("renders nothing at all when not verbose", () => {
		assert.equal(
			logUpstreamRequest({
				method: "GET",
				url: "http://up/",
				headers,
				verbose: false,
			}),
			"",
		);
		assert.equal(
			logUpstreamResponse({
				status: 200,
				httpVersion: "1.1",
				url: "http://up/",
				headers,
				verbose: false,
			}),
			"",
		);
		assert.equal(
			logOutgoingResponse({
				status: 200,
				remote: "127.0.0.1:1",
				headers,
				verbose: false,
			}),
			"",
		);
	});

	it("renders the upstream request block", () => {
		const lines = logUpstreamRequest({
			method: "POST",
			url: "http://127.0.0.1:19999/users",
			headers,
			verbose: true,
		}).split("\n");

		assert.equal(
			lines[0],
			`${ESC}[1;36m\u250c\u2500Upstream request${ESC}[0m to ${ESC}[33mhttp://127.0.0.1:19999/users${ESC}[0m`,
		);
		assert.equal(
			lines[1],
			`${ESC}[1;36m\u2502${ESC}[0m ${ESC}[32mPOST${ESC}[0m ${ESC}[4;36mhttp://127.0.0.1:19999/users${ESC}[0m ${ESC}[34mHTTP${ESC}[0m/${ESC}[34m1.1${ESC}[0m`,
		);
		assert.equal(
			lines[2],
			`${ESC}[1;36m\u2502${ESC}[0m ${ESC}[36mContent-Type${ESC}[0m: text/plain`,
		);
		assert.equal(
			lines[3],
			`${ESC}[1;36m\u2502${ESC}[0m ${ESC}[36mX-B3-Traceid${ESC}[0m: abc`,
		);
	});

	it("renders the upstream response block with the reason phrase", () => {
		const lines = logUpstreamResponse({
			status: 404,
			httpVersion: "1.0",
			url: "http://up/",
			headers: [],
			verbose: true,
		}).split("\n");

		assert.equal(
			lines[0],
			`${ESC}[1;34m\u250c\u2500Upstream response${ESC}[0m from ${ESC}[33mhttp://up/${ESC}[0m`,
		);
		assert.equal(
			lines[1],
			`${ESC}[1;34m\u2502${ESC}[0m ${ESC}[34mHTTP${ESC}[0m/${ESC}[34m1.0${ESC}[0m ${ESC}[34m404${ESC}[0m ${ESC}[36mNot Found${ESC}[0m`,
		);
		assert.equal(lines.length, 2);
	});

	it("renders the outgoing response block", () => {
		const lines = logOutgoingResponse({
			status: 500,
			remote: "127.0.0.1:52259",
			headers: [["date", "Wed, 02 Sep 2026 12:23:20 GMT"]],
			verbose: true,
		}).split("\n");

		assert.equal(
			lines[0],
			`${ESC}[1;31m\u250c\u2500Outgoing response${ESC}[0m to ${ESC}[1;35m127.0.0.1:52259${ESC}[0m`,
		);
		assert.equal(
			lines[1],
			`${ESC}[1;31m\u2502${ESC}[0m ${ESC}[34mHTTP${ESC}[0m/${ESC}[34m1.1${ESC}[0m ${ESC}[34m500${ESC}[0m ${ESC}[36mInternal Server Error${ESC}[0m`,
		);
		assert.equal(
			lines[2],
			`${ESC}[1;31m\u2502${ESC}[0m ${ESC}[36mDate${ESC}[0m: Wed, 02 Sep 2026 12:23:20 GMT`,
		);
	});
});
