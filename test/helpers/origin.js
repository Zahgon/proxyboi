import { createServer } from "node:http";
import { gzipSync } from "node:zlib";

/**
 * @typedef {object} Origin
 * @property {number} port
 * @property {string} url
 * @property {Array<{method: string, url: string, rawHeaders: string[], body: string}>} requests
 * @property {() => Promise<void>} close
 */

/**
 * Start a throwaway upstream server exposing the routes the end-to-end tests
 * need. Listens on an ephemeral port so tests can run concurrently.
 *
 * @returns {Promise<Origin>}
 */
export function startOrigin() {
	/** @type {Origin["requests"]} */
	const requests = [];

	const server = createServer((req, res) => {
		/** @type {Buffer[]} */
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			requests.push({
				method: req.method ?? "",
				url: req.url ?? "",
				rawHeaders: [...req.rawHeaders],
				body: Buffer.concat(chunks).toString("utf8"),
			});

			const url = new URL(req.url ?? "/", "http://origin.invalid");

			if (url.pathname === "/gzip") {
				const payload = gzipSync(Buffer.from("compressible payload"));
				res.writeHead(200, {
					"content-type": "text/plain",
					"content-encoding": "gzip",
					"content-length": String(payload.length),
				});
				res.end(payload);
				return;
			}

			if (url.pathname === "/big") {
				const size = Number(url.searchParams.get("n") ?? "0");
				res.writeHead(200, {
					"content-type": "application/octet-stream",
				});
				res.end(Buffer.alloc(size, 0x61));
				return;
			}

			if (url.pathname === "/echolen") {
				res.writeHead(200, { "content-type": "text/plain" });
				res.end(String(Buffer.concat(chunks).length));
				return;
			}

			if (url.pathname === "/dup") {
				res.writeHead(200, {
					"content-type": "text/plain",
					"x-dup": ["u1", "u2"],
					"x-origin": "yes",
				});
				res.end("dup");
				return;
			}

			if (url.pathname === "/status") {
				res.writeHead(Number(url.searchParams.get("c") ?? "200"));
				res.end();
				return;
			}

			res.writeHead(200, {
				"content-type": "text/plain",
				"x-origin": "yes",
			});
			res.end("origin-ok");
		});
	});

	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port =
				typeof address === "object" && address ? address.port : 0;
			resolve({
				port,
				url: `http://127.0.0.1:${port}`,
				requests,
				close: () =>
					new Promise((done) => {
						server.closeAllConnections();
						server.close(() => done());
					}),
			});
		});
	});
}
