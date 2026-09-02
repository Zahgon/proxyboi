/**
 * Port of `src/tls_utils.rs`.
 *
 * The Rust original reads PEM files with `rustls::internal::pemfile`, whose
 * `extract` loop `extractPem` reproduces line for line:
 *
 *   - a line *starting with* the BEGIN mark opens a section and a line starting
 *     with the END mark closes it, base64-decoding whatever accumulated;
 *   - a file containing no such marks yields an empty `Vec` and **no error**, so
 *     a non-PEM `--cert` starts the server with an empty chain rather than
 *     aborting;
 *   - the sole failure is base64 that does not decode, which is what the
 *     "invalid certificate" / "invalid RSA private key" / "invalid pkcs8
 *     private key" diagnostics actually report — an *encrypted* key matches
 *     neither mark and so reaches the `assert!` instead;
 *   - PKCS#1 is read before PKCS#8, but PKCS#8 wins when both parse;
 *   - `assert!` (i.e. a panic) when neither yields a key.
 *
 * Node's TLS stack accepts PEM directly, so the parsing here exists purely to
 * reproduce those diagnostics and that preference order.
 */

import { readFileSync } from "node:fs";

import { IoOtherError } from "./error.js";

const CERTIFICATE_BEGIN = "-----BEGIN CERTIFICATE-----";
const CERTIFICATE_END = "-----END CERTIFICATE-----";
const PKCS1_BEGIN = "-----BEGIN RSA PRIVATE KEY-----";
const PKCS1_END = "-----END RSA PRIVATE KEY-----";
const PKCS8_BEGIN = "-----BEGIN PRIVATE KEY-----";
const PKCS8_END = "-----END PRIVATE KEY-----";

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Whether `text` decodes under the `base64` crate's `STANDARD` config, which
 * demands canonical padding and rejects every character outside the alphabet.
 * `Buffer.from(text, "base64")` cannot answer this: it skips invalid input
 * silently instead of reporting it.
 *
 * @param {string} text
 * @returns {boolean}
 */
function decodesAsBase64(text) {
	return text.length % 4 === 0 && BASE64_PATTERN.test(text);
}

/**
 * Reproduce `rustls::internal::pemfile::extract`.
 *
 * @param {string} pem raw file contents
 * @param {string} beginMark
 * @param {string} endMark
 * @returns {string[] | null} one PEM section per match, or `null` for `Err(())`
 */
function extractPem(pem, beginMark, endMark) {
	/** @type {string[]} */
	const sections = [];
	/** @type {string[]} */
	let body = [];
	let base64 = "";
	let taking = false;

	for (const line of pem.split("\n")) {
		if (line.startsWith(beginMark)) {
			taking = true;
			continue;
		}

		if (line.startsWith(endMark)) {
			taking = false;

			if (!decodesAsBase64(base64)) {
				return null;
			}

			sections.push([beginMark, ...body, endMark].join("\n"));
			body = [];
			base64 = "";
			continue;
		}

		if (taking) {
			body.push(line.trimEnd());
			base64 += line.trim();
		}
	}

	return sections;
}

/**
 * Read the certificate chain from a PEM file.
 *
 * @param {string} path
 * @returns {string} PEM text holding every certificate found, in file order;
 *   empty when the file holds none, matching `certs()` returning `Ok(vec![])`
 * @throws {IoOtherError}
 */
export function loadCert(path) {
	const certificates = extractPem(
		readFileSync(path, "utf8"),
		CERTIFICATE_BEGIN,
		CERTIFICATE_END,
	);

	if (certificates === null) {
		throw new IoOtherError("File contains an invalid certificate");
	}

	if (certificates.length === 0) {
		return "";
	}

	return `${certificates.join("\n")}\n`;
}

/**
 * Read the private key from a PEM file.
 *
 * @param {string} path
 * @returns {string} PEM text for exactly one private key
 * @throws {Error}
 */
export function loadPrivateKey(path) {
	const pem = readFileSync(path, "utf8");

	// PKCS#1 is parsed first, so a file whose sections are *both* corrupt
	// reports the RSA diagnostic rather than the PKCS#8 one.
	const pkcs1 = extractPem(pem, PKCS1_BEGIN, PKCS1_END);
	if (pkcs1 === null) {
		throw new IoOtherError("File contains invalid RSA private key");
	}

	const pkcs8 = extractPem(pem, PKCS8_BEGIN, PKCS8_END);
	if (pkcs8 === null) {
		throw new IoOtherError(
			"File contains invalid pkcs8 private key (encrypted keys not supported)",
		);
	}

	if (pkcs8.length > 0) {
		// Matches the Rust original, which prefers PKCS#8 when both are present.
		return `${pkcs8[0]}\n`;
	}

	if (pkcs1.length > 0) {
		return `${pkcs1[0]}\n`;
	}

	// The Rust version reaches an `assert!` here and aborts the process; we
	// surface the same fatal outcome through the normal error path instead of
	// pretending the key loaded. Deliberately *not* an `IoOtherError`: Rust
	// produces no `io::Error` on this path at all.
	// See PORTING_NOTES.md ("Deliberate deviations").
	throw new Error("File contains no usable private key");
}
