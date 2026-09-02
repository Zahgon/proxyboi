import assert from "node:assert/strict";
import { request as httpsRequest } from "node:https";
import { after, before, describe, it } from "node:test";

import { parseArgs } from "../src/args.js";
import { initLogger } from "../src/logging.js";
import { createProxyServer } from "../src/server.js";
import { startOrigin } from "./helpers/origin.js";
import { httpRequest } from "./helpers/proxy.js";
import { CERT_PEM, PKCS8_KEY_PEM, writePem } from "./helpers/tls.js";

/**
 * @param {string[]} argv
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
async function listen(argv) {
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
 * @param {number} port
 * @returns {Promise<{ status: number, body: string }>}
 */
function tlsRequest(port) {
	return new Promise((resolve, reject) => {
		const req = httpsRequest(
			{
				host: "127.0.0.1",
				port,
				path: "/",
				rejectUnauthorized: false,
			},
			(res) => {
				/** @type {Buffer[]} */
				const chunks = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("end", () =>
					resolve({
						status: res.statusCode ?? 0,
						body: Buffer.concat(chunks).toString("utf8"),
					}),
				);
			},
		);
		req.on("error", reject);
		req.end();
	});
}

describe("createProxyServer", () => {
	/** @type {Awaited<ReturnType<typeof startOrigin>>} */
	let origin;
	/** @type {string} */
	let certPath;
	/** @type {string} */
	let keyPath;

	before(async () => {
		initLogger({ quiet: true });
		origin = await startOrigin();
		certPath = writePem("cert.pem", CERT_PEM);
		keyPath = writePem("key.pem", PKCS8_KEY_PEM);
	});

	after(async () => {
		await origin.close();
		initLogger({ quiet: false });
	});

	it("serves plain HTTP when no TLS material is configured", async () => {
		const proxy = await listen(["-l", "127.0.0.1:0", origin.url]);

		try {
			const res = await httpRequest({ port: proxy.port });
			assert.equal(res.status, 200);
			assert.equal(res.body.toString(), "origin-ok");
		} finally {
			await proxy.close();
		}
	});

	it("terminates TLS when both --cert and --key are given", async () => {
		const proxy = await listen([
			"-l",
			"127.0.0.1:0",
			"--cert",
			certPath,
			"--key",
			keyPath,
			origin.url,
		]);

		try {
			const res = await tlsRequest(proxy.port);
			assert.equal(res.status, 200);
			assert.equal(res.body, "origin-ok");
		} finally {
			await proxy.close();
		}
	});

	it("reports x-forwarded-proto as https on a TLS listener", async () => {
		origin.requests.length = 0;
		const proxy = await listen([
			"-l",
			"127.0.0.1:0",
			"--cert",
			certPath,
			"--key",
			keyPath,
			origin.url,
		]);

		try {
			await tlsRequest(proxy.port);
			const raw = origin.requests.at(-1)?.rawHeaders ?? [];
			const index = raw.findIndex(
				(name, i) =>
					i % 2 === 0 && name.toLowerCase() === "x-forwarded-proto",
			);

			assert.notEqual(index, -1);
			assert.equal(raw[index + 1], "https");
		} finally {
			await proxy.close();
		}
	});

	it("falls back to plain HTTP when only --cert is given", async () => {
		const proxy = await listen([
			"-l",
			"127.0.0.1:0",
			"--cert",
			certPath,
			origin.url,
		]);

		try {
			const res = await httpRequest({ port: proxy.port });
			assert.equal(res.status, 200);
		} finally {
			await proxy.close();
		}
	});

	it("falls back to plain HTTP when only --key is given", async () => {
		const proxy = await listen([
			"-l",
			"127.0.0.1:0",
			"--key",
			keyPath,
			origin.url,
		]);

		try {
			const res = await httpRequest({ port: proxy.port });
			assert.equal(res.status, 200);
		} finally {
			await proxy.close();
		}
	});
});
