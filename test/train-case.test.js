import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { splitWords, toTrainCase } from "../src/train-case.js";

describe("toTrainCase", () => {
	const cases = [
		["content-type", "Content-Type"],
		["x-forwarded-for", "X-Forwarded-For"],
		["user-agent", "User-Agent"],
		["content-md5", "Content-Md5"],
		["dnt", "Dnt"],
		["sec-ch-ua", "Sec-Ch-Ua"],
		["x-b3-traceid", "X-B3-Traceid"],
		["x-a1b2", "X-A1-B2"],
		["x-mixed-case", "X-Mixed-Case"],
		["keep-alive", "Keep-Alive"],
		["set-cookie", "Set-Cookie"],
		["transfer-encoding", "Transfer-Encoding"],
		["x-origin", "X-Origin"],
		["accept", "Accept"],
		["host", "Host"],
		["date", "Date"],
		["connection", "Connection"],
		["via", "Via"],
	];

	for (const [input, expected] of cases) {
		it(`converts ${input} to ${expected}`, () => {
			assert.equal(toTrainCase(input), expected);
		});
	}

	it("returns an empty string for empty input", () => {
		assert.equal(toTrainCase(""), "");
	});
});

describe("splitWords", () => {
	it("splits on non-alphanumeric boundaries", () => {
		assert.deepEqual(splitWords("x-forwarded-for"), [
			"x",
			"forwarded",
			"for",
		]);
	});

	it("splits on a lowercase to uppercase boundary", () => {
		assert.deepEqual(splitWords("contentType"), ["content", "Type"]);
	});

	it("splits on a digit to letter boundary", () => {
		assert.deepEqual(splitWords("a1b2"), ["a1", "b2"]);
	});

	it("does not split on a letter to digit boundary", () => {
		assert.deepEqual(splitWords("b3"), ["b3"]);
	});
});
