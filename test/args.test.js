import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	CliError,
	CliExit,
	HELP_TEXT,
	parseArgs,
	parseHeader,
	parseSocketAddr,
	parseTimeout,
	parseUpstreamUrl,
} from "../src/args.js";

/**
 * @param {string[]} argv
 * @returns {CliError}
 */
function expectCliError(argv) {
	try {
		parseArgs(argv);
	} catch (err) {
		assert.ok(err instanceof CliError, `expected CliError, got ${err}`);
		return err;
	}
	throw new assert.AssertionError({ message: `expected ${argv} to fail` });
}

describe("parseHeader", () => {
	it("splits on a single colon and trims both sides", () => {
		const map = parseHeader("  X-Test : hello world  ");
		assert.deepEqual([...map], [["x-test", "hello world"]]);
	});

	it("rejects a value containing a colon", () => {
		assert.throws(() => parseHeader("a:b:c"), {
			message: "Wrong header format (see --help for format)",
		});
	});

	it("rejects a missing colon", () => {
		assert.throws(() => parseHeader("a"), {
			message: "Wrong header format (see --help for format)",
		});
	});

	it("rejects an invalid header name", () => {
		assert.throws(() => parseHeader("A B:c"), {
			message: "invalid HTTP header name",
		});
	});
});

describe("parseSocketAddr", () => {
	it("parses an IPv4 socket address", () => {
		assert.deepEqual(parseSocketAddr("0.0.0.0:8080"), {
			ip: "0.0.0.0",
			port: 8080,
			isIpv6: false,
		});
	});

	it("parses a bracketed IPv6 socket address", () => {
		assert.deepEqual(parseSocketAddr("[::1]:8080"), {
			ip: "::1",
			port: 8080,
			isIpv6: true,
		});
	});

	it("rejects a hostname", () => {
		assert.throws(() => parseSocketAddr("localhost:8080"), {
			message: "invalid socket address syntax",
		});
	});

	it("rejects a missing port", () => {
		assert.throws(() => parseSocketAddr("127.0.0.1"), {
			message: "invalid socket address syntax",
		});
	});
});

describe("parseUpstreamUrl", () => {
	it("parses an absolute URL", () => {
		assert.equal(
			parseUpstreamUrl("http://localhost:8080").href,
			"http://localhost:8080/",
		);
	});

	it("rejects a relative URL", () => {
		assert.throws(() => parseUpstreamUrl("example.com"), {
			message: "relative URL without a base",
		});
	});
});

describe("parseTimeout", () => {
	it("parses a non-negative integer", () => {
		assert.equal(parseTimeout("0"), 0);
		assert.equal(parseTimeout("30"), 30);
	});

	it("rejects a non-numeric value", () => {
		assert.throws(() => parseTimeout("abc"), {
			message: "invalid digit found in string",
		});
	});
});

describe("parseArgs", () => {
	it("applies the documented defaults", () => {
		const args = parseArgs(["http://localhost:9000"]);
		assert.deepEqual(args.listen, {
			ip: "0.0.0.0",
			port: 8080,
			isIpv6: false,
		});
		assert.equal(args.insecure, false);
		assert.equal(args.quiet, false);
		assert.equal(args.verbose, false);
		assert.equal(args.timeout, 5);
		assert.equal(args.upstream.href, "http://localhost:9000/");
		assert.deepEqual(args.upstreamHeaders, []);
		assert.deepEqual(args.responseHeaders, []);
		assert.equal(args.tlsCert, undefined);
		assert.equal(args.tlsKey, undefined);
	});

	it("accepts short flag clusters", () => {
		const args = parseArgs(["-kqv", "http://localhost:9000"]);
		assert.equal(args.insecure, true);
		assert.equal(args.quiet, true);
		assert.equal(args.verbose, true);
	});

	it("accepts both --opt=value and --opt value", () => {
		const a = parseArgs(["--listen=127.0.0.1:1", "http://x.test"]);
		const b = parseArgs(["--listen", "127.0.0.1:1", "http://x.test"]);
		assert.deepEqual(a.listen, b.listen);
	});

	it("collects repeated header options in order", () => {
		const args = parseArgs([
			"--upstream-header",
			"a:1",
			"--upstream-header",
			"b:2",
			"--response-header",
			"c:3",
			"http://x.test",
		]);
		assert.deepEqual(
			args.upstreamHeaders.map((h) => [...h]),
			[[["a", "1"]], [["b", "2"]]],
		);
		assert.deepEqual(
			args.responseHeaders.map((h) => [...h]),
			[[["c", "3"]]],
		);
	});

	it("treats everything after -- as positional", () => {
		const args = parseArgs(["--", "http://x.test"]);
		assert.equal(args.upstream.href, "http://x.test/");
	});

	it("exits successfully for --help", () => {
		try {
			parseArgs(["--help"]);
			throw new Error("expected CliExit");
		} catch (err) {
			assert.ok(err instanceof CliExit);
			assert.equal(err.exitCode, 0);
			assert.equal(err.message, HELP_TEXT);
		}
	});

	it("exits successfully for --version", () => {
		for (const flag of ["-V", "--version"]) {
			try {
				parseArgs([flag]);
				throw new Error("expected CliExit");
			} catch (err) {
				assert.ok(err instanceof CliExit);
				assert.equal(err.exitCode, 0);
				assert.match(err.message, /^proxyboi \d+\.\d+\.\d+/);
			}
		}
	});
});

describe("parseArgs errors", () => {
	it("reports a missing upstream", () => {
		const err = expectCliError([]);
		assert.equal(err.exitCode, 2);
		assert.equal(
			err.message,
			"error: the following required arguments were not provided:\n  <UPSTREAM>\n\nUsage: proxyboi <UPSTREAM>\n\nFor more information, try '--help'.",
		);
	});

	it("reports a relative upstream URL", () => {
		const err = expectCliError(["example.com"]);
		assert.equal(
			err.message,
			"error: invalid value 'example.com' for '<UPSTREAM>': relative URL without a base\n\nFor more information, try '--help'.",
		);
	});

	it("reports an invalid listen address", () => {
		const err = expectCliError(["-l", "localhost:8080", "http://x.test"]);
		assert.equal(
			err.message,
			"error: invalid value 'localhost:8080' for '--listen <LISTEN>': invalid socket address syntax\n\nFor more information, try '--help'.",
		);
	});

	it("reports a malformed upstream header", () => {
		const err = expectCliError([
			"--upstream-header",
			"a:b:c",
			"http://x.test",
		]);
		assert.equal(
			err.message,
			"error: invalid value 'a:b:c' for '--upstream-header <UPSTREAM_HEADERS>': Wrong header format (see --help for format)\n\nFor more information, try '--help'.",
		);
	});

	it("reports an unknown flag", () => {
		const err = expectCliError(["--nope", "http://x.test"]);
		assert.match(err.message, /^error: unexpected argument '--nope' found/);
	});

	it("suggests -- for a negative number", () => {
		const err = expectCliError(["--timeout", "-1", "http://x.test"]);
		assert.equal(
			err.message,
			"error: unexpected argument '-1' found\n\n  tip: to pass '-1' as a value, use '-- -1'\n\nUsage: proxyboi [OPTIONS] <UPSTREAM>\n\nFor more information, try '--help'.",
		);
	});

	it("does not require --key alongside --cert", () => {
		const args = parseArgs(["--cert", "/tmp/cert.pem", "http://x.test"]);
		assert.equal(args.tlsCert, "/tmp/cert.pem");
		assert.equal(args.tlsKey, undefined);
	});
});

describe("eager value validation", () => {
	it("reports a bad --listen before the missing upstream", () => {
		assert.equal(
			expectCliError(["-l", "nonsense"]).message,
			"error: invalid value 'nonsense' for '--listen <LISTEN>': invalid socket address syntax\n\nFor more information, try '--help'.",
		);
	});

	it("reports a bad --timeout before the missing upstream", () => {
		assert.equal(
			expectCliError(["--timeout", "http://127.0.0.1:9"]).message,
			"error: invalid value 'http://127.0.0.1:9' for '--timeout <TIMEOUT>': invalid digit found in string\n\nFor more information, try '--help'.",
		);
	});
});

describe("repeated arguments", () => {
	const duplicates = /** @type {Array<[string[], string]>} */ ([
		[["-v", "-v"], "--verbose"],
		[["-k", "-k"], "--insecure"],
		[["-q", "-q"], "--quiet"],
		[["-l", "1.2.3.4:1", "-l", "2.3.4.5:2"], "--listen <LISTEN>"],
		[["--timeout=5", "--timeout=6"], "--timeout <TIMEOUT>"],
		[["--cert", "a", "--cert", "b"], "--cert <TLS_CERT>"],
		[["--key", "a", "--key", "b"], "--key <TLS_KEY>"],
	]);

	for (const [flags, display] of duplicates) {
		it(`rejects a second ${display}`, () => {
			const err = expectCliError([...flags, "http://127.0.0.1:9"]);

			assert.match(
				err.message,
				new RegExp(
					`^error: the argument '${display.replace(/[<>]/g, "\\$&")}' cannot be used multiple times\\n\\nUsage: proxyboi \\[OPTIONS\\] <UPSTREAM>`,
				),
			);
		});
	}

	it("allows repeated header options", () => {
		const args = parseArgs([
			"--upstream-header",
			"a:b",
			"--upstream-header",
			"c:d",
			"--response-header",
			"e:f",
			"--response-header",
			"g:h",
			"http://127.0.0.1:9",
		]);

		assert.equal(args.upstreamHeaders.length, 2);
		assert.equal(args.responseHeaders.length, 2);
	});
});

describe("did-you-mean suggestions", () => {
	const alternatives =
		"Usage: proxyboi <--listen <LISTEN>|--insecure|--quiet|--verbose|UPSTREAM|--upstream-header <UPSTREAM_HEADERS>|--response-header <RESPONSE_HEADERS>|--timeout <TIMEOUT>|--cert <TLS_CERT>|--key <TLS_KEY>>";

	const suggested = [
		["--lis", "--listen"],
		["--Listen", "--listen"],
		["--insecur", "--insecure"],
		["--quie", "--quiet"],
		["--verbos", "--verbose"],
		["--time", "--timeout"],
		["--upstream-heade", "--upstream-header"],
		["--respons-header", "--response-header"],
		["--certt", "--cert"],
		["--k", "--key"],
	];

	for (const [typo, expected] of suggested) {
		it(`suggests ${expected} for ${typo}`, () => {
			assert.equal(
				expectCliError([typo, "http://127.0.0.1:9"]).message,
				`error: unexpected argument '${typo}' found\n\n  tip: a similar argument exists: '${expected}'\n\n${alternatives}\n\nFor more information, try '--help'.`,
			);
		});
	}

	it("prefers --version over --verbose on a tie", () => {
		assert.equal(
			expectCliError(["--ver", "http://127.0.0.1:9"]).message,
			"error: unexpected argument '--ver' found\n\n  tip: a similar argument exists: '--version'\n\nUsage: proxyboi --version <UPSTREAM>\n\nFor more information, try '--help'.",
		);
	});

	it("builds the usage line from an exclusive suggestion", () => {
		assert.equal(
			expectCliError(["--hel", "http://127.0.0.1:9"]).message,
			"error: unexpected argument '--hel' found\n\n  tip: a similar argument exists: '--help'\n\nUsage: proxyboi --help <UPSTREAM>\n\nFor more information, try '--help'.",
		);
	});

	it("falls back to the quoting tip when nothing is similar", () => {
		for (const typo of ["--kkk", "--zzzzzzzz", "--nope"]) {
			assert.equal(
				expectCliError([typo, "http://127.0.0.1:9"]).message,
				`error: unexpected argument '${typo}' found\n\n  tip: to pass '${typo}' as a value, use '-- ${typo}'\n\nUsage: proxyboi [OPTIONS] <UPSTREAM>\n\nFor more information, try '--help'.`,
			);
		}
	});
});
