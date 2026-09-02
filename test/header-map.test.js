import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HeaderMap } from "../src/header-map.js";

describe("HeaderMap append ordering", () => {
	it("puts the second value before the first when promoting to a list", () => {
		const map = new HeaderMap();
		map.append("x-new", "n1");
		map.append("x-new", "n2");
		map.append("x-new", "n3");
		assert.deepEqual(map.getAll("x-new"), ["n2", "n1", "n3"]);
	});

	it("cancels the swap out when copying an already-duplicated header", () => {
		const upstream = HeaderMap.fromRawHeaders([
			"x-dup",
			"u1",
			"x-dup",
			"u2",
		]);
		assert.deepEqual(upstream.getAll("x-dup"), ["u2", "u1"]);

		const outgoing = new HeaderMap();
		for (const [name, value] of upstream) {
			outgoing.append(name, value);
		}
		outgoing.append("x-dup", "cli1");
		outgoing.append("x-dup", "cli2");
		assert.deepEqual(outgoing.getAll("x-dup"), [
			"u1",
			"u2",
			"cli1",
			"cli2",
		]);
	});

	it("emits a command line value before a single upstream value", () => {
		const outgoing = new HeaderMap();
		outgoing.append("x-origin", "yes");
		outgoing.append("x-origin", "appended");
		assert.deepEqual(outgoing.getAll("x-origin"), ["appended", "yes"]);
	});
});

describe("HeaderMap basics", () => {
	it("lowercases names on every access path", () => {
		const map = new HeaderMap();
		map.insert("X-Mixed-Case", "v");
		assert.equal(map.get("x-mixed-case"), "v");
		assert.ok(map.has("X-MIXED-CASE"));
		assert.deepEqual(map.toFlatHeaders(), ["x-mixed-case", "v"]);
	});

	it("replaces every value on insert", () => {
		const map = new HeaderMap();
		map.append("a", "1");
		map.append("a", "2");
		map.insert("a", "3");
		assert.deepEqual(map.getAll("a"), ["3"]);
	});

	it("counts duplicates separately in length", () => {
		const map = new HeaderMap();
		map.append("a", "1");
		map.append("a", "2");
		map.append("b", "3");
		assert.equal(map.length, 3);
	});

	it("deletes a key entirely", () => {
		const map = new HeaderMap();
		map.append("transfer-encoding", "chunked");
		assert.equal(map.delete("Transfer-Encoding"), true);
		assert.equal(map.has("transfer-encoding"), false);
		assert.equal(map.delete("transfer-encoding"), false);
	});

	it("returns an empty list for a missing key", () => {
		assert.deepEqual(new HeaderMap().getAll("nope"), []);
		assert.equal(new HeaderMap().get("nope"), undefined);
	});

	it("renders duplicates as arrays for outgoing requests", () => {
		const map = new HeaderMap();
		map.insert("host", "example.com");
		map.append("set-cookie", "a=1");
		map.append("set-cookie", "b=2");
		assert.deepEqual(map.toOutgoingHeaders(), {
			host: "example.com",
			"set-cookie": ["b=2", "a=1"],
		});
	});

	it("preserves insertion order across distinct keys", () => {
		const map = HeaderMap.fromRawHeaders(["Host", "h", "Accept", "a"]);
		assert.deepEqual(
			[...map],
			[
				["host", "h"],
				["accept", "a"],
			],
		);
	});
});
