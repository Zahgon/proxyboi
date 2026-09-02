import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadCert, loadPrivateKey } from "../src/tls-utils.js";
import {
	CERT_PEM,
	ENCRYPTED_KEY_PEM,
	PKCS1_KEY_PEM,
	PKCS8_KEY_PEM,
	corrupt,
	writePem,
} from "./helpers/tls.js";

describe("loadCert", () => {
	it("reads a single certificate", () => {
		const pem = loadCert(writePem("cert.pem", CERT_PEM));

		assert.match(pem, /^-----BEGIN CERTIFICATE-----/);
		assert.match(pem, /-----END CERTIFICATE-----\n$/);
		assert.equal(pem.match(/BEGIN CERTIFICATE/g)?.length, 1);
	});

	it("reads a whole chain in file order", () => {
		const pem = loadCert(
			writePem("chain.pem", `${CERT_PEM}\n${CERT_PEM}\n`),
		);

		assert.equal(pem.match(/BEGIN CERTIFICATE/g)?.length, 2);
	});

	it("ignores surrounding text", () => {
		const pem = loadCert(
			writePem(
				"annotated.pem",
				`subject=CN = localhost\n${CERT_PEM}\ntrailing junk\n`,
			),
		);

		assert.match(pem, /^-----BEGIN CERTIFICATE-----/);
	});

	// rustls `certs()` returns `Ok(vec![])` here, so proxyboi serves an empty chain.
	it("returns an empty chain for a file with no certificate in it", () => {
		assert.equal(loadCert(writePem("key-only.pem", PKCS8_KEY_PEM)), "");
	});

	it("returns an empty chain for a file that is not PEM at all", () => {
		assert.equal(loadCert(writePem("plain.txt", "not a pem file\n")), "");
	});

	it("rejects a certificate section whose base64 does not decode", () => {
		assert.throws(
			() => loadCert(writePem("corrupt.pem", corrupt(CERT_PEM))),
			{
				message: "File contains an invalid certificate",
				debugRepr:
					'Custom { kind: Other, error: "File contains an invalid certificate" }',
			},
		);
	});
});

describe("loadPrivateKey", () => {
	it("reads a PKCS#8 key", () => {
		const pem = loadPrivateKey(writePem("pkcs8.pem", PKCS8_KEY_PEM));

		assert.match(pem, /^-----BEGIN PRIVATE KEY-----/);
		assert.match(pem, /-----END PRIVATE KEY-----\n$/);
	});

	it("reads a PKCS#1 key", () => {
		const pem = loadPrivateKey(writePem("pkcs1.pem", PKCS1_KEY_PEM));

		assert.match(pem, /^-----BEGIN RSA PRIVATE KEY-----/);
		assert.match(pem, /-----END RSA PRIVATE KEY-----\n$/);
	});

	it("prefers PKCS#8 when a file carries both encodings", () => {
		const pem = loadPrivateKey(
			writePem("both.pem", `${PKCS1_KEY_PEM}\n${PKCS8_KEY_PEM}`),
		);

		assert.match(pem, /^-----BEGIN PRIVATE KEY-----/);
	});

	it("returns only the first key of a multi-key file", () => {
		const pem = loadPrivateKey(
			writePem("many.pem", `${PKCS8_KEY_PEM}\n${PKCS8_KEY_PEM}`),
		);

		assert.equal(pem.match(/BEGIN PRIVATE KEY/g)?.length, 1);
	});

	// "-----BEGIN ENCRYPTED PRIVATE KEY-----" starts with neither mark, so Rust
	// finds no key at all and hits its `assert!` rather than the pkcs8 message.
	it("refuses an encrypted key", () => {
		assert.throws(
			() => loadPrivateKey(writePem("enc.pem", ENCRYPTED_KEY_PEM)),
			{ message: "File contains no usable private key" },
		);
	});

	it("rejects a file with no key in it", () => {
		assert.throws(() => loadPrivateKey(writePem("cert.pem", CERT_PEM)), {
			message: "File contains no usable private key",
		});
	});

	it("rejects a PKCS#1 section whose base64 does not decode", () => {
		assert.throws(
			() =>
				loadPrivateKey(writePem("bad-rsa.pem", corrupt(PKCS1_KEY_PEM))),
			{
				message: "File contains invalid RSA private key",
				debugRepr:
					'Custom { kind: Other, error: "File contains invalid RSA private key" }',
			},
		);
	});

	it("rejects a PKCS#8 section whose base64 does not decode", () => {
		assert.throws(
			() =>
				loadPrivateKey(
					writePem("bad-pkcs8.pem", corrupt(PKCS8_KEY_PEM)),
				),
			{
				message:
					"File contains invalid pkcs8 private key (encrypted keys not supported)",
				debugRepr:
					'Custom { kind: Other, error: "File contains invalid pkcs8 private key (encrypted keys not supported)" }',
			},
		);
	});

	it("reports the PKCS#1 diagnostic when both sections are corrupt", () => {
		assert.throws(
			() =>
				loadPrivateKey(
					writePem(
						"bad-both.pem",
						`${corrupt(PKCS1_KEY_PEM)}\n${corrupt(PKCS8_KEY_PEM)}`,
					),
				),
			{ message: "File contains invalid RSA private key" },
		);
	});
});
