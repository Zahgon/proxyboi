import { spawn } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import { connect, createServer } from "node:net";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../../bin/proxyboi.js", import.meta.url));

/** @returns {Promise<number>} a currently-free TCP port on the loopback device */
export function freePort() {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.on("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			const port =
				typeof address === "object" && address ? address.port : 0;
			probe.close(() => resolve(port));
		});
	});
}

/**
 * @typedef {object} Proxy
 * @property {number} port
 * @property {() => string} stdout
 * @property {() => string} stderr
 * @property {(signal?: NodeJS.Signals) => Promise<number>} stop
 */

/**
 * Spawn the CLI and resolve once it reports that it is listening.
 *
 * @param {string[]} args extra arguments placed before the upstream
 * @param {string} upstream
 * @returns {Promise<Proxy>}
 */
export async function startProxy(args, upstream) {
	const port = await freePort();
	const child = spawn(
		process.execPath,
		[BIN, "-l", `127.0.0.1:${port}`, ...args, upstream],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);

	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.setEncoding("utf8").on("data", (chunk) => {
		stderr += chunk;
	});

	await waitForPort(port, child);

	return {
		port,
		stdout: () => stdout,
		stderr: () => stderr,
		stop: async (signal = "SIGTERM") => {
			if (child.exitCode !== null) {
				return child.exitCode;
			}
			child.kill(signal);
			const [code] = await once(child, "exit");
			return code ?? 0;
		},
	};
}

/**
 * Spawn the CLI without waiting for it to start listening.
 *
 * @param {string[]} argv
 * @returns {{ stdout: () => string, stderr: () => string, exit: () => Promise<number> }}
 */
export function spawnCli(argv) {
	const child = spawn(process.execPath, [BIN, ...argv], {
		stdio: ["ignore", "pipe", "pipe"],
	});

	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.setEncoding("utf8").on("data", (chunk) => {
		stderr += chunk;
	});

	return {
		stdout: () => stdout,
		stderr: () => stderr,
		exit: async () => {
			const [code] = await once(child, "exit");
			return code ?? 0;
		},
	};
}

/**
 * Hold a loopback port open so a bind against it fails.
 *
 * @returns {Promise<{ port: number, release: () => Promise<void> }>}
 */
export function occupyPort() {
	return new Promise((resolve, reject) => {
		const holder = createServer();
		holder.on("error", reject);
		holder.listen(0, "127.0.0.1", () => {
			const address = holder.address();
			resolve({
				port: typeof address === "object" && address ? address.port : 0,
				release: () =>
					new Promise((done) => holder.close(() => done())),
			});
		});
	});
}

/**
 * @param {number} port
 * @param {import("node:child_process").ChildProcess} child
 * @returns {Promise<void>}
 */
async function waitForPort(port, child) {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(`proxy exited early with code ${child.exitCode}`);
		}
		const reachable = await new Promise((resolve) => {
			const probe = request(
				{
					host: "127.0.0.1",
					port,
					method: "GET",
					path: "/",
					timeout: 250,
				},
				(res) => {
					res.resume();
					resolve(true);
				},
			);
			probe.on("error", () => resolve(false));
			probe.on("timeout", () => {
				probe.destroy();
				resolve(false);
			});
			probe.end();
		});
		if (reachable) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`proxy did not start listening on ${port}`);
}

/**
 * @typedef {object} Response
 * @property {number} status
 * @property {string} statusMessage
 * @property {string[]} rawHeaders
 * @property {Buffer} body
 */

/**
 * @param {object} options
 * @param {number} options.port
 * @param {string} [options.path]
 * @param {string} [options.method]
 * @param {Record<string, string | string[]>} [options.headers]
 * @param {Buffer | string} [options.body]
 * @returns {Promise<Response>}
 */
export function httpRequest({
	port,
	path = "/",
	method = "GET",
	headers = {},
	body,
}) {
	return new Promise((resolve, reject) => {
		const req = request(
			{ host: "127.0.0.1", port, method, path, headers },
			(res) => {
				/** @type {Buffer[]} */
				const chunks = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("end", () =>
					resolve({
						status: res.statusCode ?? 0,
						statusMessage: res.statusMessage ?? "",
						rawHeaders: [...res.rawHeaders],
						body: Buffer.concat(chunks),
					}),
				);
			},
		);
		req.on("error", reject);
		if (body !== undefined) {
			req.write(body);
		}
		req.end();
	});
}

/**
 * Issue a request over a bare socket and return whatever bytes come back.
 *
 * Node's HTTP client treats 1xx responses as interim and never surfaces them
 * as a response, so informational statuses can only be observed at this level.
 *
 * @param {object} options
 * @param {number} options.port
 * @param {string} [options.path]
 * @param {string} [options.method]
 * @param {number} [options.settleMs] how long to collect bytes before giving up
 * @returns {Promise<string>}
 */
export function rawRequest({
	port,
	path = "/",
	method = "GET",
	settleMs = 500,
}) {
	return new Promise((resolve, reject) => {
		const socket = connect(port, "127.0.0.1", () => {
			socket.write(
				`${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`,
			);
		});

		let received = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			received += chunk;
		});
		socket.on("error", reject);

		setTimeout(() => {
			socket.destroy();
			resolve(received);
		}, settleMs).unref();
	});
}

/**
 * Read a header from a `rawHeaders` array, returning every occurrence.
 *
 * @param {readonly string[]} raw
 * @param {string} name
 * @returns {string[]}
 */
export function headerValues(raw, name) {
	/** @type {string[]} */
	const values = [];
	for (let i = 0; i + 1 < raw.length; i += 2) {
		if (raw[i].toLowerCase() === name.toLowerCase()) {
			values.push(raw[i + 1]);
		}
	}
	return values;
}
