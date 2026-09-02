import assert from "node:assert/strict";
import { createServer } from "node:https";
import { after, before, describe, it } from "node:test";

import { parseArgs } from "../src/args.js";
import { initLogger } from "../src/logging.js";
import { createProxyServer } from "../src/server.js";
import { BODY_LIMIT } from "../src/upstream.js";
import { startOrigin } from "./helpers/origin.js";
import { headerValues, httpRequest } from "./helpers/proxy.js";
import { CERT_PEM, PKCS8_KEY_PEM } from "./helpers/tls.js";

/**
 * @typedef {object} InProcessProxy
 * @property {number} port
 * @property {() => Promise<void>} close
 */

/**
 * @param {string[]} argv
 * @returns {Promise<InProcessProxy>}
 */
async function startProxy(argv) {
	const server = createProxyServer(parseArgs(argv));
	await new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve(undefined));
	});

	const address = server.address();

	return {
		port: typeof address === "object" && address ? address.port : 0,
		close: () =>
			new Promise((done) => {
				server.closeAllConnections();
				server.close(() => done());
			}),
	};
}

/**
 * @template T
 * @param {() => Promise<T>} body
 * @returns {Promise<{ result: T, stderr: string }>}
 */
async function captureStderr(body) {
	const original = process.stderr.write;
	let stderr = "";
	process.stderr.write = /** @type {any} */ (
		(/** @type {string} */ chunk) => {
			stderr += chunk;
			return true;
		}
	);

	try {
		return { result: await body(), stderr };
	} finally {
		process.stderr.write = original;
	}
}

describe("handler against a live origin", () => {
	/** @type {Awaited<ReturnType<typeof startOrigin>>} */
	let origin;
	/** @type {InProcessProxy} */
	let proxy;
	/** @type {InProcessProxy} */
	let verbose;

	before(async () => {
		initLogger({ quiet: true });
		origin = await startOrigin();
		proxy = await startProxy(["-l", "127.0.0.1:0", origin.url]);
		verbose = await startProxy(["-l", "127.0.0.1:0", "-v", origin.url]);
	});

	after(async () => {
		await proxy.close();
		await verbose.close();
		await origin.close();
		initLogger({ quiet: false });
	});

	it("proxies a GET and recomputes the content length first", async () => {
		const res = await httpRequest({ port: proxy.port });

		assert.equal(res.status, 200);
		assert.equal(res.statusMessage, "OK");
		assert.equal(res.body.toString(), "origin-ok");
		assert.equal(res.rawHeaders[0].toLowerCase(), "content-length");
		assert.equal(res.rawHeaders[1], "9");
		assert.equal(res.rawHeaders[2].toLowerCase(), "date");
	});

	it("adds the hop headers to the upstream request", async () => {
		origin.requests.length = 0;
		await httpRequest({ port: proxy.port, path: "/hop" });
		const upstream = origin.requests.at(-1);

		assert.ok(upstream);
		assert.equal(
			headerValues(upstream.rawHeaders, "via")[0],
			"HTTP/1.1 proxyboi",
		);
		assert.equal(
			headerValues(upstream.rawHeaders, "x-forwarded-proto")[0],
			"http",
		);
		assert.equal(
			headerValues(upstream.rawHeaders, "x-forwarded-for")[0],
			"127.0.0.1",
		);
		assert.match(
			headerValues(upstream.rawHeaders, "forwarded")[0],
			/^by=127\.0\.0\.1;for=127\.0\.0\.1;host=127\.0\.0\.1:\d+;proto=http$/,
		);
	});

	it("forwards a request body and its recomputed length", async () => {
		const res = await httpRequest({
			port: proxy.port,
			path: "/echolen",
			method: "POST",
			body: "hello world",
		});

		assert.equal(res.body.toString(), "11");
	});

	it("discards the upstream path", async () => {
		origin.requests.length = 0;
		const nested = await startProxy([
			"-l",
			"127.0.0.1:0",
			`${origin.url}/ignored/prefix`,
		]);

		try {
			await httpRequest({ port: nested.port, path: "/users?a=b" });
			assert.equal(origin.requests.at(-1)?.url, "/users?a=b");
		} finally {
			await nested.close();
		}
	});

	it("accepts credentials in the upstream URL", async () => {
		const credentialed = await startProxy([
			"-l",
			"127.0.0.1:0",
			`http://user:secret@127.0.0.1:${origin.port}`,
		]);

		try {
			const res = await httpRequest({ port: credentialed.port });
			assert.equal(res.status, 200);
		} finally {
			await credentialed.close();
		}
	});

	it("renders every log block in verbose mode", async () => {
		const res = await httpRequest({ port: verbose.port, path: "/dup" });

		assert.equal(res.status, 200);
		assert.deepEqual(headerValues(res.rawHeaders, "x-dup"), ["u1", "u2"]);
	});

	it("returns an empty body with a zero length for HEAD", async () => {
		const res = await httpRequest({ port: proxy.port, method: "HEAD" });

		assert.equal(res.status, 200);
		assert.equal(headerValues(res.rawHeaders, "content-length")[0], "0");
	});

	it("omits the content length on a 204", async () => {
		const res = await httpRequest({
			port: proxy.port,
			path: "/status?c=204",
		});

		assert.equal(res.status, 204);
		assert.deepEqual(headerValues(res.rawHeaders, "content-length"), []);
	});

	it("strips connection and transfer-encoding from the response", async () => {
		const res = await httpRequest({ port: proxy.port, path: "/big?n=16" });

		assert.deepEqual(headerValues(res.rawHeaders, "transfer-encoding"), []);
		assert.equal(res.body.length, 16);
	});

	it("accepts bodies of exactly the limit in both directions", async () => {
		const request = await httpRequest({
			port: proxy.port,
			path: "/echolen",
			method: "POST",
			body: Buffer.alloc(BODY_LIMIT, 0x61),
		});
		assert.equal(request.body.toString(), String(BODY_LIMIT));

		const response = await httpRequest({
			port: proxy.port,
			path: `/big?n=${BODY_LIMIT}`,
		});
		assert.equal(response.body.length, BODY_LIMIT);
	});

	it("rejects an over-large request body with 413", async () => {
		const res = await httpRequest({
			port: proxy.port,
			path: "/echolen",
			method: "POST",
			body: Buffer.alloc(BODY_LIMIT + 1, 0x61),
		});

		assert.equal(res.status, 413);
		assert.equal(res.body.toString(), "A payload reached size limit.");
		assert.equal(headerValues(res.rawHeaders, "content-length")[0], "29");
		assert.equal(
			headerValues(res.rawHeaders, "content-type")[0],
			"text/plain; charset=utf-8",
		);
	});

	it("fails an over-large response body with 500", async () => {
		const { result: res, stderr } = await captureStderr(() =>
			httpRequest({ port: proxy.port, path: `/big?n=${BODY_LIMIT + 1}` }),
		);

		assert.equal(res.status, 500);
		assert.equal(res.body.length, 0);
		assert.match(stderr, /Unknown Internal Error/);
		assert.match(stderr, /PayloadError\(Overflow\)/);
	});

	it("applies the command line header options", async () => {
		origin.requests.length = 0;
		const decorated = await startProxy([
			"-l",
			"127.0.0.1:0",
			"--upstream-header",
			"user-agent:replaced",
			"--response-header",
			"x-extra:added",
			origin.url,
		]);

		try {
			const res = await httpRequest({
				port: decorated.port,
				headers: { "user-agent": "original" },
			});

			assert.equal(
				headerValues(origin.requests[0].rawHeaders, "user-agent")[0],
				"replaced",
			);
			assert.equal(headerValues(res.rawHeaders, "x-extra")[0], "added");
		} finally {
			await decorated.close();
		}
	});
});

describe("handler failure paths", () => {
	before(() => initLogger({ quiet: true }));
	after(() => initLogger({ quiet: false }));

	it("answers 500 when the upstream refuses the connection", async () => {
		const dead = await startProxy([
			"-l",
			"127.0.0.1:0",
			"http://127.0.0.1:1",
		]);

		try {
			const { result: res, stderr } = await captureStderr(() =>
				httpRequest({ port: dead.port }),
			);

			assert.equal(res.status, 500);
			assert.equal(
				headerValues(res.rawHeaders, "content-length")[0],
				"0",
			);
			assert.match(stderr, /Unknown Internal Error/);
			assert.match(stderr, /SendRequestError\(Connect\(/);
		} finally {
			await dead.close();
		}
	});

	it("answers 500 when the connection times out", async () => {
		const stalled = await startProxy([
			"-l",
			"127.0.0.1:0",
			"--timeout",
			"1",
			"http://192.0.2.1:81",
		]);

		try {
			const { result: res, stderr } = await captureStderr(() =>
				httpRequest({ port: stalled.port }),
			);

			assert.equal(res.status, 500);
			assert.match(stderr, /SendRequestError\(Connect\(Timeout\)\)/);
		} finally {
			await stalled.close();
		}
	});

	it("treats --timeout 0 as expiring immediately, not as disabled", async () => {
		const reachable = await startOrigin();
		const instant = await startProxy([
			"-l",
			"127.0.0.1:0",
			"--timeout",
			"0",
			reachable.url,
		]);

		try {
			const { result: res, stderr } = await captureStderr(() =>
				httpRequest({ port: instant.port }),
			);

			assert.equal(res.status, 500);
			assert.match(stderr, /SendRequestError\(Connect\(Timeout\)\)/);
		} finally {
			await instant.close();
			await reachable.close();
		}
	});
});

describe("handler against a TLS origin", () => {
	/** @type {import("node:https").Server} */
	let origin;
	/** @type {number} */
	let originPort;

	before(async () => {
		initLogger({ quiet: true });
		origin = createServer(
			{ cert: CERT_PEM, key: PKCS8_KEY_PEM },
			(_req, res) => {
				res.writeHead(200, { "content-type": "text/plain" });
				res.end("secure-ok");
			},
		);
		await new Promise((resolve) => {
			origin.listen(0, "127.0.0.1", () => resolve(undefined));
		});
		const address = origin.address();
		originPort = typeof address === "object" && address ? address.port : 0;
	});

	after(async () => {
		await new Promise((done) => {
			origin.closeAllConnections();
			origin.close(() => done(undefined));
		});
		initLogger({ quiet: false });
	});

	it("proxies to a self-signed upstream with --insecure", async () => {
		const proxy = await startProxy([
			"-l",
			"127.0.0.1:0",
			"-k",
			`https://localhost:${originPort}`,
		]);

		try {
			const res = await httpRequest({ port: proxy.port });

			assert.equal(res.status, 200);
			assert.equal(res.body.toString(), "secure-ok");
		} finally {
			await proxy.close();
		}
	});

	it("refuses a self-signed upstream without --insecure", async () => {
		const proxy = await startProxy([
			"-l",
			"127.0.0.1:0",
			`https://localhost:${originPort}`,
		]);

		try {
			const { result: res, stderr } = await captureStderr(() =>
				httpRequest({ port: proxy.port }),
			);

			assert.equal(res.status, 500);
			assert.match(stderr, /SendRequestError\(/);
		} finally {
			await proxy.close();
		}
	});
});
