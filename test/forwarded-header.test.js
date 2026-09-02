import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ForwardedHeader } from "../src/forwarded-header.js";

describe("ForwardedHeader.fromInfo", () => {
	it("handles an unknown peer and an empty for", () => {
		const header = ForwardedHeader.fromInfo(
			"unknown",
			"0.0.0.0",
			"",
			"unknown",
			"http",
		);
		assert.equal(
			header.toString(),
			"by=0.0.0.0;for=unknown;host=unknown;proto=http",
		);
	});

	it("handles a known peer and host", () => {
		const header = ForwardedHeader.fromInfo(
			"192.168.0.100",
			"0.0.0.0",
			"",
			"localhost:8080",
			"http",
		);
		assert.equal(
			header.toString(),
			"by=0.0.0.0;for=192.168.0.100;host=localhost:8080;proto=http",
		);
	});

	it("handles a known peer and host with a previous for", () => {
		const header = ForwardedHeader.fromInfo(
			"192.168.0.100",
			"0.0.0.0",
			"for=192.168.0.99",
			"localhost:8080",
			"http",
		);
		assert.equal(
			header.toString(),
			"by=0.0.0.0;for=192.168.0.99, for=192.168.0.100;host=localhost:8080;proto=http",
		);
	});

	it("handles a known peer and host with multiple previous for", () => {
		const header = ForwardedHeader.fromInfo(
			"192.168.0.100",
			"0.0.0.0",
			"for=192.168.0.97,for=192.168.0.98,for=192.168.0.99",
			"localhost:8080",
			"http",
		);
		assert.equal(
			header.toString(),
			"by=0.0.0.0;for=192.168.0.97, for=192.168.0.98, for=192.168.0.99, for=192.168.0.100;host=localhost:8080;proto=http",
		);
	});

	it("only consumes the segment up to the first semicolon", () => {
		const header = ForwardedHeader.fromInfo(
			"127.0.0.1",
			"0.0.0.0",
			"by=1.1.1.1;for=9.9.9.9;host=orig.com;proto=https",
			"orig.com",
			"https",
		);
		assert.equal(
			header.toString(),
			"by=0.0.0.0;for=9.9.9.9, for=127.0.0.1;host=orig.com;proto=https",
		);
	});

	it("ignores a forwarded header without a for directive", () => {
		const header = ForwardedHeader.fromInfo(
			"127.0.0.1",
			"0.0.0.0",
			"proto=https",
			"example.com",
			"https",
		);
		assert.equal(
			header.toString(),
			"by=0.0.0.0;for=127.0.0.1;host=example.com;proto=https",
		);
	});
});
