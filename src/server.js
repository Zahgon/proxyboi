/**
 * Port of the server bootstrap in `src/main.rs`.
 *
 * actix-web runs one worker per logical CPU and logs its lifecycle, so the
 * observable startup and shutdown behaviour is reproduced with `node:cluster`:
 *
 *   Starting <n> workers
 *   Starting "actix-web-service-<addr>" service on <addr>
 *   ...
 *   SIGINT received, exiting                 (immediate)
 *   SIGTERM received, stopping               (graceful)
 *   Shutting down worker, <n> connections    (once per worker)
 *
 * A failed bind is reported *before* any of that, as `main` returning an error:
 * a raw `Error: ..` line on stderr and exit status 1.
 */

import cluster from "node:cluster";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createTcpServer } from "node:net";
import { availableParallelism } from "node:os";

import { formatSocketAddr } from "./connection-info.js";
import { formatIoError } from "./error.js";
import { createHandler } from "./handler.js";
import { info } from "./logging.js";
import { loadCert, loadPrivateKey } from "./tls-utils.js";

const SHUTDOWN_MESSAGE = "proxyboi:shutdown";

/** actix-server's default `shutdown_timeout`. */
const SHUTDOWN_TIMEOUT_MS = 30_000;

/**
 * @param {import("./args.js").CliArgs} args
 * @returns {boolean}
 */
function usesTls(args) {
	// Note: proxyboi only enables TLS when *both* flags are present. The Rust
	// original declares `--cert` and `--key` as mutually requiring, but the
	// declaration references stale argument ids and is silently inert, so a
	// lone `--cert` starts a plain HTTP listener instead of failing.
	return args.tlsCert !== undefined && args.tlsKey !== undefined;
}

/**
 * Build the HTTP (or HTTPS) server for a single worker.
 *
 * @param {import("./args.js").CliArgs} args
 * @returns {import("node:http").Server}
 */
export function createProxyServer(args) {
	const isTls = usesTls(args);
	const handler = createHandler({ args, isTls });

	/** @type {import("node:http").RequestListener} */
	const listener = (req, res) => {
		handler(req, res).catch(() => {
			if (!res.headersSent) {
				res.sendDate = false;
				res.writeHead(500, [
					"content-length",
					"0",
					"date",
					new Date().toUTCString(),
				]);
			}
			res.end();
		});
	};

	if (isTls) {
		return createHttpsServer(
			{
				cert: loadCert(/** @type {string} */ (args.tlsCert)),
				key: loadPrivateKey(/** @type {string} */ (args.tlsKey)),
			},
			listener,
		);
	}

	return createHttpServer(listener);
}

/**
 * Verify the listen address is available before anything is logged, so that a
 * clash produces the same bare error the Rust binary emits.
 *
 * @param {import("./args.js").CliArgs} args
 * @returns {Promise<void>}
 */
function probeBind(args) {
	return new Promise((resolve, reject) => {
		const probe = createTcpServer();
		probe.once("error", reject);
		probe.listen(
			{ host: args.listen.ip, port: args.listen.port, exclusive: true },
			() => {
				probe.close(() => resolve());
			},
		);
	});
}

/**
 * @param {unknown} err
 * @returns {never}
 */
function failFast(err) {
	const debugRepr = /** @type {{ debugRepr?: unknown }} */ (err).debugRepr;

	let detail;
	if (typeof debugRepr === "string") {
		detail = debugRepr;
	} else if (
		typeof (/** @type {NodeJS.ErrnoException} */ (err).code) === "string"
	) {
		detail = formatIoError(/** @type {NodeJS.ErrnoException} */ (err));
	} else {
		detail = /** @type {Error} */ (err).message;
	}

	process.stderr.write(`Error: ${detail}\n`);
	process.exit(1);
}

/**
 * @param {import("./args.js").CliArgs} args
 * @returns {Promise<void>}
 */
async function runPrimary(args) {
	if (usesTls(args)) {
		try {
			loadCert(/** @type {string} */ (args.tlsCert));
			loadPrivateKey(/** @type {string} */ (args.tlsKey));
		} catch (err) {
			failFast(err);
		}
	}

	try {
		await probeBind(args);
	} catch (err) {
		failFast(err);
	}

	const workers = availableParallelism();
	const address = formatSocketAddr(args.listen.ip, args.listen.port);

	info(`Starting ${workers} workers`);
	info(`Starting "actix-web-service-${address}" service on ${address}`);

	for (let i = 0; i < workers; i += 1) {
		cluster.fork();
	}

	let stopping = false;

	process.on("SIGINT", () => {
		if (stopping) return;
		stopping = true;
		info("SIGINT received, exiting");
		for (const worker of Object.values(cluster.workers ?? {})) {
			worker?.process.kill("SIGKILL");
		}
		process.exit(0);
	});

	process.on("SIGTERM", () => {
		if (stopping) return;
		stopping = true;
		info("SIGTERM received, stopping");
		for (const worker of Object.values(cluster.workers ?? {})) {
			worker?.send(SHUTDOWN_MESSAGE);
		}
	});

	cluster.on("exit", () => {
		if (stopping && Object.keys(cluster.workers ?? {}).length === 0) {
			process.exit(0);
		}
	});
}

/**
 * @param {import("./args.js").CliArgs} args
 */
function runWorker(args) {
	// Terminal signals reach the whole process group, but actix's workers only
	// react to instructions from the accept loop, so ignore them here.
	process.on("SIGINT", () => {});
	process.on("SIGTERM", () => {});

	const server = createProxyServer(args);

	let connections = 0;
	server.on("connection", (socket) => {
		connections += 1;
		socket.on("close", () => {
			connections -= 1;
		});
	});

	process.on("message", (message) => {
		if (message !== SHUTDOWN_MESSAGE) return;

		if (connections === 0) {
			info("Shutting down worker, 0 connections");
			process.exit(0);
		}

		info(`Graceful worker shutdown, ${connections} connections`);
		server.close(() => process.exit(0));
		server.closeIdleConnections?.();
		setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS).unref();
	});

	server.listen({ host: args.listen.ip, port: args.listen.port });
}

/**
 * Entry point used by `bin/proxyboi.js`.
 *
 * @param {import("./args.js").CliArgs} args
 * @returns {Promise<void>}
 */
export async function runServer(args) {
	if (cluster.isPrimary) {
		await runPrimary(args);
	} else {
		runWorker(args);
	}
}
