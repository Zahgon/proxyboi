import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	connectionInfo,
	formatSocketAddr,
	normalizeIp,
} from "../src/connection-info.js";

/**
 * @param {Record<string, string | string[]>} headers
 * @param {{ remoteAddress?: string, remotePort?: number }} [socket]
 * @returns {import("node:http").IncomingMessage}
 */
function fakeRequest(headers, socket = {}) {
	return /** @type {any} */ ({
		headers,
		socket: { remoteAddress: "127.0.0.1", remotePort: 52259, ...socket },
	});
}

describe("connectionInfo defaults", () => {
	it("falls back to http, localhost and the peer address with its port", () => {
		const info = connectionInfo(fakeRequest({}), false);

		assert.deepEqual(info, {
			scheme: "http",
			host: "localhost",
			realipRemoteAddr: "127.0.0.1:52259",
			peerAddr: "127.0.0.1:52259",
			peerIp: "127.0.0.1",
		});
	});

	it("reports https when the listener terminates TLS", () => {
		assert.equal(connectionInfo(fakeRequest({}), true).scheme, "https");
	});

	it("uses the Host header when no forwarding headers are present", () => {
		const info = connectionInfo(
			fakeRequest({ host: "example.com:8080" }),
			false,
		);
		assert.equal(info.host, "example.com:8080");
	});

	it("drops the port when the socket reports none", () => {
		const info = connectionInfo(
			fakeRequest({}, { remotePort: undefined }),
			false,
		);
		assert.equal(info.peerAddr, "127.0.0.1");
		assert.equal(info.realipRemoteAddr, "127.0.0.1");
	});

	it("brackets an IPv6 peer", () => {
		const info = connectionInfo(
			fakeRequest({}, { remoteAddress: "::1" }),
			false,
		);
		assert.equal(info.peerAddr, "[::1]:52259");
		assert.equal(info.peerIp, "::1");
	});
});

describe("connectionInfo Forwarded parsing", () => {
	it("reads proto, host and for out of a single Forwarded header", () => {
		const info = connectionInfo(
			fakeRequest({
				forwarded: "by=1.1.1.1;for=9.9.9.9;host=orig.com;proto=https",
			}),
			false,
		);

		assert.equal(info.scheme, "https");
		assert.equal(info.host, "orig.com");
		assert.equal(info.realipRemoteAddr, "9.9.9.9");
	});

	it("strips surrounding quotes", () => {
		const info = connectionInfo(
			fakeRequest({
				forwarded: 'for="[2001:db8::1]:4711";host="orig.com"',
			}),
			false,
		);

		assert.equal(info.realipRemoteAddr, "[2001:db8::1]:4711");
		assert.equal(info.host, "orig.com");
	});

	it("keeps the first occurrence of each directive", () => {
		const info = connectionInfo(
			fakeRequest({
				forwarded: "for=1.1.1.1, for=2.2.2.2;proto=http, proto=https",
			}),
			false,
		);

		assert.equal(info.realipRemoteAddr, "1.1.1.1");
		assert.equal(info.scheme, "http");
	});

	it("ignores malformed and empty elements", () => {
		const info = connectionInfo(
			fakeRequest({ forwarded: "garbage;for=;proto=;host=" }),
			false,
		);

		assert.equal(info.scheme, "http");
		assert.equal(info.host, "localhost");
		assert.equal(info.realipRemoteAddr, "127.0.0.1:52259");
	});

	it("accepts a repeated Forwarded header", () => {
		const info = connectionInfo(
			fakeRequest({ forwarded: ["proto=https", "for=9.9.9.9"] }),
			false,
		);

		assert.equal(info.scheme, "https");
		assert.equal(info.realipRemoteAddr, "9.9.9.9");
	});

	it("wins over the X-Forwarded-* headers", () => {
		const info = connectionInfo(
			fakeRequest({
				forwarded: "for=9.9.9.9;proto=https;host=orig.com",
				"x-forwarded-for": "8.8.8.8",
				"x-forwarded-proto": "http",
				"x-forwarded-host": "other.com",
			}),
			false,
		);

		assert.equal(info.scheme, "https");
		assert.equal(info.host, "orig.com");
		assert.equal(info.realipRemoteAddr, "9.9.9.9");
	});
});

describe("connectionInfo X-Forwarded-* parsing", () => {
	it("takes the first element of each header", () => {
		const info = connectionInfo(
			fakeRequest({
				"x-forwarded-for": "8.8.8.8, 127.0.0.1",
				"x-forwarded-proto": "https, http",
				"x-forwarded-host": "first.com, second.com",
			}),
			false,
		);

		assert.equal(info.realipRemoteAddr, "8.8.8.8");
		assert.equal(info.scheme, "https");
		assert.equal(info.host, "first.com");
	});

	it("accepts a repeated header and reads its first entry", () => {
		const info = connectionInfo(
			fakeRequest({ "x-forwarded-for": ["8.8.8.8", "1.1.1.1"] }),
			false,
		);

		assert.equal(info.realipRemoteAddr, "8.8.8.8");
	});

	it("ignores an empty header", () => {
		const info = connectionInfo(
			fakeRequest({
				"x-forwarded-for": "",
				"x-forwarded-proto": "  ",
				"x-forwarded-host": "",
				host: "fallback.com",
			}),
			false,
		);

		assert.equal(info.realipRemoteAddr, "127.0.0.1:52259");
		assert.equal(info.scheme, "http");
		assert.equal(info.host, "fallback.com");
	});

	it("ignores an empty repeated header", () => {
		const info = connectionInfo(
			fakeRequest({ "x-forwarded-for": [] }),
			false,
		);

		assert.equal(info.realipRemoteAddr, "127.0.0.1:52259");
	});
});

describe("normalizeIp", () => {
	it("reports an absent or empty address as unknown", () => {
		assert.equal(normalizeIp(undefined), "unknown");
		assert.equal(normalizeIp(""), "unknown");
	});

	it("unwraps IPv4-mapped IPv6 addresses", () => {
		assert.equal(normalizeIp("::ffff:127.0.0.1"), "127.0.0.1");
	});

	it("leaves genuine IPv6 addresses alone", () => {
		assert.equal(normalizeIp("::1"), "::1");
		assert.equal(normalizeIp("::ffff:abcd"), "::ffff:abcd");
	});

	it("leaves plain IPv4 addresses alone", () => {
		assert.equal(normalizeIp("192.168.0.1"), "192.168.0.1");
	});
});

describe("formatSocketAddr", () => {
	it("joins IPv4 hosts with a colon", () => {
		assert.equal(formatSocketAddr("0.0.0.0", 8080), "0.0.0.0:8080");
	});

	it("brackets IPv6 hosts", () => {
		assert.equal(formatSocketAddr("::", 8080), "[::]:8080");
	});
});
