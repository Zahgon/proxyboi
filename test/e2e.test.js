import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { gunzipSync } from "node:zlib";
import { startOrigin } from "./helpers/origin.js";
import {
	freePort,
	headerValues,
	httpRequest,
	occupyPort,
	rawRequest,
	spawnCli,
	startProxy,
} from "./helpers/proxy.js";

const BODY_LIMIT = 262_144;

describe("end to end proxying", () => {
	/** @type {Awaited<ReturnType<typeof startOrigin>>} */
	let origin;
	/** @type {Awaited<ReturnType<typeof startProxy>>} */
	let proxy;

	before(async () => {
		origin = await startOrigin();
		proxy = await startProxy([], origin.url);
	});

	after(async () => {
		await proxy.stop();
		await origin.close();
	});

	it("proxies a plain GET", async () => {
		const res = await httpRequest({ port: proxy.port, path: "/plain" });
		assert.equal(res.status, 200);
		assert.equal(res.body.toString(), "origin-ok");
		assert.deepEqual(headerValues(res.rawHeaders, "x-origin"), ["yes"]);
	});

	it("recomputes content-length and puts it first", async () => {
		const res = await httpRequest({ port: proxy.port, path: "/plain" });
		assert.equal(res.rawHeaders[0].toLowerCase(), "content-length");
		assert.equal(res.rawHeaders[1], String(res.body.length));
		assert.equal(res.rawHeaders[2].toLowerCase(), "date");
	});

	it("strips connection and transfer-encoding from the response", async () => {
		const res = await httpRequest({ port: proxy.port, path: "/plain" });
		assert.deepEqual(headerValues(res.rawHeaders, "connection"), []);
		assert.deepEqual(headerValues(res.rawHeaders, "transfer-encoding"), []);
	});

	it("adds the proxy hop headers to the upstream request", async () => {
		origin.requests.length = 0;
		await httpRequest({ port: proxy.port, path: "/plain" });
		const seen = origin.requests.at(-1);
		assert.ok(seen);
		const header = (/** @type {string} */ name) =>
			headerValues(seen.rawHeaders, name)[0];
		assert.equal(header("via"), "HTTP/1.1 proxyboi");
		assert.equal(header("x-forwarded-for"), "127.0.0.1");
		assert.equal(header("x-forwarded-proto"), "http");
		assert.equal(
			header("forwarded"),
			`by=127.0.0.1;for=127.0.0.1;host=127.0.0.1:${proxy.port};proto=http`,
		);
	});

	it("forwards the client Host header verbatim", async () => {
		origin.requests.length = 0;
		await httpRequest({ port: proxy.port, path: "/plain" });
		const seen = origin.requests.at(-1);
		assert.ok(seen);
		assert.equal(
			headerValues(seen.rawHeaders, "host")[0],
			`127.0.0.1:${proxy.port}`,
		);
	});

	it("chains onto existing forwarded, via and x-forwarded-for headers", async () => {
		origin.requests.length = 0;
		await httpRequest({
			port: proxy.port,
			path: "/plain",
			headers: {
				forwarded: "by=1.1.1.1;for=9.9.9.9;host=orig.com;proto=https",
				via: "HTTP/1.0 otherproxy",
				"x-forwarded-for": "8.8.8.8",
			},
		});
		const seen = origin.requests.at(-1);
		assert.ok(seen);
		const header = (/** @type {string} */ name) =>
			headerValues(seen.rawHeaders, name)[0];
		assert.equal(
			header("forwarded"),
			"by=127.0.0.1;for=9.9.9.9, for=127.0.0.1;host=orig.com;proto=https",
		);
		assert.equal(header("via"), "HTTP/1.0 otherproxy, HTTP/1.1 proxyboi");
		assert.equal(header("x-forwarded-for"), "8.8.8.8, 127.0.0.1");
		assert.equal(header("x-forwarded-proto"), "https");
		assert.equal(header("x-forwarded-host"), "orig.com");
	});

	it("discards the upstream path and uses the incoming target", async () => {
		const withPath = await startProxy([], `${origin.url}/api/v1`);
		try {
			origin.requests.length = 0;
			await httpRequest({ port: withPath.port, path: "/users?a=b" });
			assert.equal(origin.requests.at(-1)?.url, "/users?a=b");
		} finally {
			await withPath.stop();
		}
	});

	it("passes a gzip body through undecoded", async () => {
		const res = await httpRequest({ port: proxy.port, path: "/gzip" });
		assert.deepEqual(headerValues(res.rawHeaders, "content-encoding"), [
			"gzip",
		]);
		assert.equal(gunzipSync(res.body).toString(), "compressible payload");
	});

	it("returns an empty body for HEAD", async () => {
		const res = await httpRequest({
			port: proxy.port,
			path: "/plain",
			method: "HEAD",
		});
		assert.equal(res.status, 200);
		assert.equal(res.body.length, 0);
		assert.deepEqual(headerValues(res.rawHeaders, "content-length"), ["0"]);
	});

	it("forwards the upstream status code", async () => {
		const res = await httpRequest({
			port: proxy.port,
			path: "/status?c=418",
		});
		assert.equal(res.status, 418);
	});

	it("sends no content-length on 204", async () => {
		const raw = await rawRequest({
			port: proxy.port,
			path: "/status?c=204",
		});
		assert.match(raw, /^HTTP\/1\.1 204 No Content\r\n/);
		assert.doesNotMatch(raw, /\r\ncontent-length:/i);
	});

	for (const status of [205, 304]) {
		it(`still sends content-length: 0 on ${status}`, async () => {
			const raw = await rawRequest({
				port: proxy.port,
				path: `/status?c=${status}`,
			});
			assert.match(raw, /\r\ncontent-length: 0\r\n/);
		});
	}

	for (const status of [100, 102]) {
		it(`forwards ${status} without a content-length`, async () => {
			const raw = await rawRequest({
				port: proxy.port,
				path: `/status?c=${status}`,
			});
			assert.match(raw, new RegExp(`^HTTP/1\\.1 ${status} `));
			assert.doesNotMatch(raw, /\r\ncontent-length:/i);
		});
	}
});

describe("body limits", () => {
	/** @type {Awaited<ReturnType<typeof startOrigin>>} */
	let origin;
	/** @type {Awaited<ReturnType<typeof startProxy>>} */
	let proxy;

	before(async () => {
		origin = await startOrigin();
		proxy = await startProxy([], origin.url);
	});

	after(async () => {
		await proxy.stop();
		await origin.close();
	});

	it("accepts a request body of exactly the limit", async () => {
		const res = await httpRequest({
			port: proxy.port,
			path: "/echolen",
			method: "POST",
			body: Buffer.alloc(BODY_LIMIT, 0x61),
		});
		assert.equal(res.status, 200);
		assert.equal(res.body.toString(), String(BODY_LIMIT));
	});

	it("rejects a request body one byte over the limit with 413", async () => {
		const res = await httpRequest({
			port: proxy.port,
			path: "/echolen",
			method: "POST",
			body: Buffer.alloc(BODY_LIMIT + 1, 0x61),
		});
		assert.equal(res.status, 413);
		assert.equal(res.statusMessage, "Payload Too Large");
		assert.equal(res.body.toString(), "A payload reached size limit.");
		assert.deepEqual(headerValues(res.rawHeaders, "content-length"), [
			"29",
		]);
		assert.deepEqual(headerValues(res.rawHeaders, "content-type"), [
			"text/plain; charset=utf-8",
		]);
	});

	it("accepts a response body of exactly the limit", async () => {
		const res = await httpRequest({
			port: proxy.port,
			path: `/big?n=${BODY_LIMIT}`,
		});
		assert.equal(res.status, 200);
		assert.equal(res.body.length, BODY_LIMIT);
	});

	it("fails a response body one byte over the limit with 500", async () => {
		const res = await httpRequest({
			port: proxy.port,
			path: `/big?n=${BODY_LIMIT + 1}`,
		});
		assert.equal(res.status, 500);
		assert.equal(res.body.length, 0);
		assert.match(proxy.stderr(), /Unknown Internal Error/);
		assert.match(proxy.stderr(), /PayloadError\(Overflow\)/);
	});
});

describe("header options", () => {
	/** @type {Awaited<ReturnType<typeof startOrigin>>} */
	let origin;

	before(async () => {
		origin = await startOrigin();
	});

	after(async () => {
		await origin.close();
	});

	it("replaces an upstream header supplied on the command line", async () => {
		const proxy = await startProxy(
			["--upstream-header", "user-agent:REPLACED"],
			origin.url,
		);
		try {
			origin.requests.length = 0;
			await httpRequest({
				port: proxy.port,
				path: "/plain",
				headers: { "user-agent": "original" },
			});
			const seen = origin.requests.at(-1);
			assert.ok(seen);
			assert.deepEqual(headerValues(seen.rawHeaders, "user-agent"), [
				"REPLACED",
			]);
		} finally {
			await proxy.stop();
		}
	});

	it("appends response headers after duplicated upstream values", async () => {
		const proxy = await startProxy(
			[
				"--response-header",
				"x-dup:cli1",
				"--response-header",
				"x-dup:cli2",
			],
			origin.url,
		);
		try {
			const res = await httpRequest({ port: proxy.port, path: "/dup" });
			assert.deepEqual(headerValues(res.rawHeaders, "x-dup"), [
				"u1",
				"u2",
				"cli1",
				"cli2",
			]);
		} finally {
			await proxy.stop();
		}
	});

	it("emits a command line value before a single upstream value", async () => {
		const proxy = await startProxy(
			["--response-header", "x-origin:appended"],
			origin.url,
		);
		try {
			const res = await httpRequest({ port: proxy.port, path: "/plain" });
			assert.deepEqual(headerValues(res.rawHeaders, "x-origin"), [
				"appended",
				"yes",
			]);
		} finally {
			await proxy.stop();
		}
	});

	it("reproduces the actix promotion order on a fresh key", async () => {
		const proxy = await startProxy(
			[
				"--response-header",
				"x-new:n1",
				"--response-header",
				"x-new:n2",
				"--response-header",
				"x-new:n3",
			],
			origin.url,
		);
		try {
			const res = await httpRequest({ port: proxy.port, path: "/plain" });
			assert.deepEqual(headerValues(res.rawHeaders, "x-new"), [
				"n2",
				"n1",
				"n3",
			]);
		} finally {
			await proxy.stop();
		}
	});
});

describe("failure handling", () => {
	it("answers 500 when the upstream refuses the connection", async () => {
		const dead = await freePort();
		const proxy = await startProxy([], `http://127.0.0.1:${dead}`);
		try {
			const res = await httpRequest({ port: proxy.port, path: "/plain" });
			assert.equal(res.status, 500);
			assert.equal(res.body.length, 0);
			assert.deepEqual(headerValues(res.rawHeaders, "content-length"), [
				"0",
			]);
			assert.match(proxy.stderr(), /Unknown Internal Error/);
			assert.match(proxy.stderr(), /SendRequestError\(Connect\(/);
		} finally {
			await proxy.stop();
		}
	});

	it("keeps serving after an upstream failure", async () => {
		const origin = await startOrigin();
		const proxy = await startProxy([], origin.url);
		try {
			await origin.close();
			const failed = await httpRequest({
				port: proxy.port,
				path: "/plain",
			});
			assert.equal(failed.status, 500);

			const revived = await startOrigin();
			const second = await startProxy([], revived.url);
			try {
				const ok = await httpRequest({
					port: second.port,
					path: "/plain",
				});
				assert.equal(ok.status, 200);
			} finally {
				await second.stop();
				await revived.close();
			}
		} finally {
			await proxy.stop();
		}
	});
});

describe("logging", () => {
	it("logs one connection line per request by default", async () => {
		const origin = await startOrigin();
		const proxy = await startProxy([], origin.url);
		try {
			await httpRequest({ port: proxy.port, path: "/plain" });
			await new Promise((resolve) => setTimeout(resolve, 150));
			assert.match(proxy.stdout(), /Starting \d+ workers/);
			assert.match(
				proxy.stdout(),
				/Connection from 127\.0\.0\.1:\d+ at \[/,
			);
		} finally {
			await proxy.stop();
			await origin.close();
		}
	});

	it("renders all four blocks in verbose mode", async () => {
		const origin = await startOrigin();
		const proxy = await startProxy(["-v"], origin.url);
		try {
			await httpRequest({ port: proxy.port, path: "/plain" });
			await new Promise((resolve) => setTimeout(resolve, 150));
			const out = proxy.stdout();
			assert.match(out, /┌─Incoming request/);
			assert.match(out, /┌─Upstream request/);
			assert.match(out, /┌─Upstream response/);
			assert.match(out, /┌─Outgoing response/);
			assert.ok(
				out.includes("\u001b[4;36m"),
				"expected an underlined path",
			);
		} finally {
			await proxy.stop();
			await origin.close();
		}
	});

	it("writes nothing to stdout in quiet mode", async () => {
		const origin = await startOrigin();
		const proxy = await startProxy(["-q"], origin.url);
		try {
			await httpRequest({ port: proxy.port, path: "/plain" });
			await new Promise((resolve) => setTimeout(resolve, 150));
			assert.equal(proxy.stdout(), "");
		} finally {
			await proxy.stop();
			await origin.close();
		}
	});
});

describe("process lifecycle", () => {
	it("announces its workers and listening address", async () => {
		const origin = await startOrigin();
		const proxy = await startProxy([], origin.url);
		try {
			assert.match(proxy.stdout(), /Starting \d+ workers/);
			assert.ok(
				proxy
					.stdout()
					.includes(
						`Starting "actix-web-service-127.0.0.1:${proxy.port}" service on 127.0.0.1:${proxy.port}`,
					),
				proxy.stdout(),
			);
		} finally {
			await proxy.stop();
			await origin.close();
		}
	});

	it("shuts its workers down gracefully on SIGTERM", async () => {
		const origin = await startOrigin();
		const proxy = await startProxy([], origin.url);
		try {
			const code = await proxy.stop("SIGTERM");

			assert.equal(code, 0);
			assert.match(proxy.stdout(), /SIGTERM received, stopping/);
			assert.match(proxy.stdout(), /Shutting down worker, 0 connections/);
		} finally {
			await origin.close();
		}
	});

	it("exits immediately on SIGINT", async () => {
		const origin = await startOrigin();
		const proxy = await startProxy([], origin.url);
		try {
			const code = await proxy.stop("SIGINT");

			assert.equal(code, 0);
			assert.match(proxy.stdout(), /SIGINT received, exiting/);
		} finally {
			await origin.close();
		}
	});

	it("reports a busy listen address and exits 1 without logging", async () => {
		const holder = await occupyPort();
		const cli = spawnCli([
			"-l",
			`127.0.0.1:${holder.port}`,
			"http://127.0.0.1:1",
		]);

		try {
			const code = await cli.exit();

			assert.equal(code, 1);
			assert.equal(cli.stdout(), "");
			assert.match(
				cli.stderr(),
				/^Error: Os \{ code: \d+, kind: AddrInUse, message: "Address already in use" \}\n$/,
			);
		} finally {
			await holder.release();
		}
	});
});
