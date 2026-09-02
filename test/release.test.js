import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyReplacements } from "../scripts/release.mjs";

const CHANGELOG = [
	"# Changelog",
	"",
	"<!-- next-header -->",
	"",
	"## [Unreleased] - ReleaseDate",
	"- Something new",
	"",
	"## [0.5.0] - 2021-05-30",
	"- Upgraded to actix-web 3",
	"",
	"<!-- next-url -->",
	"[Unreleased]: https://github.com/svenstaro/proxyboi/compare/v0.5.0...HEAD",
	"[0.5.0]: https://github.com/svenstaro/proxyboi/compare/v0.4.5...v0.5.0",
	"",
].join("\n");

const README = "Run `proxyboi 0.5.1-alpha.0` to serve things.\n";

/**
 * @param {string} version
 * @returns {{ files: Map<string, string>, ctx: { tagName: string, date: string } }}
 */
function run(version) {
	const files = new Map([
		["CHANGELOG.md", CHANGELOG],
		["README.md", README],
	]);
	const ctx = applyReplacements(
		version,
		(file) => {
			const contents = files.get(file);
			assert.ok(contents !== undefined, `missing fixture: ${file}`);
			return contents;
		},
		(file, text) => files.set(file, text),
	);
	return { files, ctx };
}

describe("release replacements", () => {
	it("stamps the version and date over the release markers", () => {
		const { files, ctx } = run("0.6.0");
		const changelog = files.get("CHANGELOG.md") ?? "";

		assert.equal(ctx.tagName, "v0.6.0");
		assert.match(changelog, /## \[0\.6\.0\] - \d{4}-\d{2}-\d{2}\n/);
		assert.ok(!changelog.includes("ReleaseDate\n- Something new"));
	});

	it("re-inserts fresh Unreleased markers", () => {
		const { files } = run("0.6.0");
		const changelog = files.get("CHANGELOG.md") ?? "";

		assert.match(
			changelog,
			/<!-- next-header -->\n\n## \[Unreleased\] - ReleaseDate\n/,
		);
		assert.match(
			changelog,
			/<!-- next-url -->\n\[Unreleased\]: https:\/\/github\.com\/svenstaro\/proxyboi\/compare\/v0\.6\.0\.\.\.HEAD\n/,
		);
	});

	it("retargets the compare link of the released version", () => {
		const { files } = run("0.6.0");
		const changelog = files.get("CHANGELOG.md") ?? "";

		assert.match(
			changelog,
			/\[0\.6\.0\]: https:\/\/github\.com\/svenstaro\/proxyboi\/compare\/v0\.5\.0\.\.\.v0\.6\.0\n/,
		);
	});

	it("updates version strings in the README", () => {
		const { files } = run("0.6.0");
		assert.equal(
			files.get("README.md"),
			"Run `proxyboi 0.6.0` to serve things.\n",
		);
	});

	it("accepts prerelease versions", () => {
		const { ctx } = run("0.6.0-alpha.1");
		assert.equal(ctx.tagName, "v0.6.0-alpha.1");
	});

	it("rejects a version that is not semver", () => {
		assert.throws(() => run("v0.6"), /Not a valid semver version/);
	});

	it("fails loudly when a once-only marker is missing", () => {
		assert.throws(
			() =>
				applyReplacements(
					"0.6.0",
					() => "# Changelog without any markers\n",
					() => {},
				),
			/expected 1 match/,
		);
	});
});
