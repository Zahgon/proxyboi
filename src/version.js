/**
 * Single source of truth for the binary name and version, read from
 * `package.json` so that `npm version` keeps `--version` in sync the way
 * `cargo release` did for `Cargo.toml`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const manifestPath = fileURLToPath(new URL("../package.json", import.meta.url));

/** @type {{ name: string; version: string; description: string }} */
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

export const BIN_NAME = "proxyboi";
export const VERSION = manifest.version;
export const DESCRIPTION = manifest.description;
