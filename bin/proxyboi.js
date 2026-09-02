#!/usr/bin/env node

import { CliError, CliExit, parseArgs } from "../src/args.js";
import { initLogger } from "../src/logging.js";
import { runServer } from "../src/server.js";

/** @type {import("../src/args.js").CliArgs} */
let args;

try {
	args = parseArgs(process.argv.slice(2));
} catch (err) {
	if (err instanceof CliExit) {
		process.stdout.write(`${err.message}\n`);
		process.exit(err.exitCode);
	}
	if (err instanceof CliError) {
		process.stderr.write(`${err.message}\n`);
		process.exit(err.exitCode);
	}
	throw err;
}

initLogger({ quiet: args.quiet });

await runServer(args);
