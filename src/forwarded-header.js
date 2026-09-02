/**
 * Port of `src/forwarded_header.rs`.
 *
 * Builds the RFC 7239 `Forwarded` header that proxyboi sends upstream. The
 * parsing below is intentionally a literal translation of the Rust original,
 * quirks included:
 *
 *   - only the *first* `for=` run is considered; everything after the first
 *     `;` that follows it is ignored;
 *   - `String::replace` removes **every** occurrence of `for=` inside a
 *     comma-separated element, not just a leading one;
 *   - elements are **not** trimmed, so `for=a, for=b` yields `a` and ` b`
 *     (with the leading space preserved), exactly as the Rust version does.
 */

export class ForwardedHeader {
	/**
	 * @param {string} by interface the request was received on
	 * @param {string[]} forList chain of clients the request passed through
	 * @param {string} host host requested by the client
	 * @param {string} proto protocol used by the client
	 */
	constructor(by, forList, host, proto) {
		this.by = by;
		this.for = forList;
		this.host = host;
		this.proto = proto;
	}

	/**
	 * Derive a `Forwarded` header from connection information plus whatever the
	 * client already sent.
	 *
	 * @param {string} peer peer address of the incoming connection (IP only)
	 * @param {string} iface local interface proxyboi is listening on
	 * @param {string} forwarded raw inbound `Forwarded` header value ("" if absent)
	 * @param {string} host host as resolved from the connection info
	 * @param {string} proto scheme as resolved from the connection info
	 * @returns {ForwardedHeader}
	 */
	static fromInfo(peer, iface, forwarded, host, proto) {
		/** @type {string[]} */
		const forList = [];

		const start = forwarded.indexOf("for=");
		if (start !== -1) {
			const rest = forwarded.slice(start);
			const semicolon = rest.indexOf(";");
			const segment = semicolon === -1 ? rest : rest.slice(0, semicolon);

			for (const element of segment.split(",")) {
				forList.push(element.split("for=").join(""));
			}
		}

		forList.push(peer);

		return new ForwardedHeader(iface, forList, host, proto);
	}

	/** @returns {string} */
	toString() {
		const fors = this.for.map((value) => `for=${value}`).join(", ");
		return `by=${this.by};${fors};host=${this.host};proto=${this.proto}`;
	}
}
