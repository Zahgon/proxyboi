#!/usr/bin/env node

/**
 * Port of the original repository's `release.toml`.
 *
 * `cargo release` performed a fixed list of `pre-release-replacements` when
 * cutting a version. npm has no equivalent, so the same list is applied here
 * from the `version` lifecycle script. The order below is significant and
 * matches the original file: `Unreleased` and `ReleaseDate` are first rewritten
 * to the version being released, and only then are fresh `Unreleased` markers
 * re-inserted after the `next-header` / `next-url` anchors.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO = "https://github.com/svenstaro/proxyboi";

/**
 * @param {string} version
 * @returns {{ version: string, tagName: string, date: string }}
 */
function context(version) {
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
		throw new Error(`Not a valid semver version: ${version}`);
	}
	return {
		version,
		tagName: `v${version}`,
		date: new Date().toISOString().slice(0, 10),
	};
}

/**
 * @param {{ version: string, tagName: string, date: string }} ctx
 * @returns {{ file: string, search: RegExp, replace: string, exactly?: number }[]}
 */
function replacements(ctx) {
	return [
		{
			file: "README.md",
			search: /proxyboi [0-9][a-z0-9.-]+/g,
			replace: `proxyboi ${ctx.version}`,
		},
		{
			file: "CHANGELOG.md",
			search: /Unreleased/g,
			replace: ctx.version,
		},
		{
			file: "CHANGELOG.md",
			search: /\.\.\.HEAD/g,
			replace: `...${ctx.tagName}`,
			exactly: 1,
		},
		{
			file: "CHANGELOG.md",
			search: /ReleaseDate/g,
			replace: ctx.date,
		},
		{
			file: "CHANGELOG.md",
			search: /<!-- next-header -->/g,
			replace: "<!-- next-header -->\n\n## [Unreleased] - ReleaseDate",
		},
		{
			file: "CHANGELOG.md",
			search: /<!-- next-url -->/g,
			replace: `<!-- next-url -->\n[Unreleased]: ${REPO}/compare/${ctx.tagName}...HEAD`,
			exactly: 1,
		},
	];
}

/**
 * @param {string} version
 * @param {(file: string) => string} read
 * @param {(file: string, contents: string) => void} write
 */
export function applyReplacements(version, read, write) {
	const ctx = context(version);
	/** @type {Map<string, string>} */
	const contents = new Map();

	for (const { file, search, replace, exactly } of replacements(ctx)) {
		const before = contents.get(file) ?? read(file);
		const matches = before.match(search)?.length ?? 0;

		if (exactly !== undefined && matches !== exactly) {
			throw new Error(
				`${file}: expected ${exactly} match(es) of ${search}, found ${matches}`,
			);
		}

		contents.set(file, before.replace(search, replace));
	}

	for (const [file, text] of contents) {
		write(file, text);
	}

	return ctx;
}

function main() {
	const version = process.argv[2] ?? process.env.npm_package_version;
	if (version === undefined) {
		console.error(
			"usage: node scripts/release.mjs <version>\n" +
				"(normally run for you by `npm version <version>`)",
		);
		process.exit(2);
	}

	const root = new URL("..", import.meta.url);
	const ctx = applyReplacements(
		version,
		(file) => readFileSync(new URL(file, root), "utf8"),
		(file, text) => writeFileSync(new URL(file, root), text),
	);

	console.log(`Prepared release ${ctx.tagName} (${ctx.date})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main();
}
