/**
 * A faithful re-implementation of the header container used by the original
 * Rust stack (`actix_http::header::HeaderMap`).
 *
 * Why not a plain `Map<string, string[]>`? Because `actix_http`'s `append()`
 * has a distinctly non-obvious ordering behaviour that is directly observable
 * on the wire, and proxyboi's response path is built entirely out of `append`
 * calls. Internally actix stores either a single value or a vector of values,
 * and promoting a single value to a vector puts the **new** value first:
 *
 *   vacant                -> One(new)
 *   One(old)              -> Multi([new, old])      <-- note the swap
 *   Multi([a, b, ...])    -> Multi([a, b, ..., new])
 *
 * Empirically confirmed against the Rust binary:
 *
 *   - appending `n1`, `n2`, `n3` to a fresh key emits `n2, n1, n3`;
 *   - an upstream response carrying `x-dup: u1` + `x-dup: u2` proxied with
 *     `--response-header x-dup:cli1 --response-header x-dup:cli2` emits
 *     `u1, u2, cli1, cli2` (the swap happens twice and cancels out);
 *   - an upstream response carrying a single `x-origin: yes` proxied with
 *     `--response-header x-origin:appended` emits `appended` *before* `yes`.
 *
 * Reproducing this quirk is what keeps duplicate-header ordering byte-identical
 * with the source implementation.
 *
 * Key ordering: actix backs the map with a hash map, so the relative order of
 * *distinct* header names is effectively arbitrary (and not stable across
 * processes, since the hasher is randomly seeded). We use insertion order,
 * which is deterministic and RFC-equivalent. See PORTING_NOTES.md.
 */

/**
 * @typedef {[string, string]} HeaderEntry
 */

export class HeaderMap {
	constructor() {
		/**
		 * Lowercased header name -> list of values.
		 * @type {Map<string, string[]>}
		 */
		this._entries = new Map();
	}

	/**
	 * Build a map from a flat `[name, value, name, value, ...]` array such as
	 * `IncomingMessage#rawHeaders`, using actix's append semantics so that the
	 * resulting duplicate ordering matches what actix would have parsed.
	 *
	 * @param {readonly string[]} raw
	 * @returns {HeaderMap}
	 */
	static fromRawHeaders(raw) {
		const map = new HeaderMap();
		for (let i = 0; i + 1 < raw.length; i += 2) {
			map.append(raw[i], raw[i + 1]);
		}
		return map;
	}

	/**
	 * @param {string} name
	 * @returns {string}
	 */
	static normalize(name) {
		return String(name).toLowerCase();
	}

	/**
	 * Replace every value stored under `name` with a single `value`.
	 *
	 * Mirrors `HeaderMap::insert` / awc's `set_header`.
	 *
	 * @param {string} name
	 * @param {string} value
	 * @returns {this}
	 */
	insert(name, value) {
		this._entries.set(HeaderMap.normalize(name), [String(value)]);
		return this;
	}

	/**
	 * Add `value` under `name`, preserving actix's promotion ordering quirk.
	 *
	 * Mirrors `HeaderMap::append` / `HttpResponseBuilder::header`.
	 *
	 * @param {string} name
	 * @param {string} value
	 * @returns {this}
	 */
	append(name, value) {
		const key = HeaderMap.normalize(name);
		const existing = this._entries.get(key);
		const next = String(value);

		if (existing === undefined) {
			this._entries.set(key, [next]);
		} else if (existing.length === 1) {
			// One(old) -> Multi([new, old])
			this._entries.set(key, [next, existing[0]]);
		} else {
			existing.push(next);
		}
		return this;
	}

	/**
	 * @param {string} name
	 * @returns {string | undefined} the first value stored under `name`
	 */
	get(name) {
		const values = this._entries.get(HeaderMap.normalize(name));
		return values === undefined ? undefined : values[0];
	}

	/**
	 * @param {string} name
	 * @returns {readonly string[]}
	 */
	getAll(name) {
		return this._entries.get(HeaderMap.normalize(name)) ?? [];
	}

	/**
	 * @param {string} name
	 * @returns {boolean}
	 */
	has(name) {
		return this._entries.has(HeaderMap.normalize(name));
	}

	/**
	 * @param {string} name
	 * @returns {boolean}
	 */
	delete(name) {
		return this._entries.delete(HeaderMap.normalize(name));
	}

	/** @returns {number} total number of values (duplicates counted separately) */
	get length() {
		let total = 0;
		for (const values of this._entries.values()) {
			total += values.length;
		}
		return total;
	}

	/**
	 * Iterate every `[name, value]` pair, expanding duplicates in storage order.
	 *
	 * @returns {Generator<HeaderEntry, void, void>}
	 */
	*entries() {
		for (const [name, values] of this._entries) {
			for (const value of values) {
				yield/** @type {HeaderEntry} */ ([name, value]);
			}
		}
	}

	/** @returns {Generator<HeaderEntry, void, void>} */
	[Symbol.iterator]() {
		return this.entries();
	}

	/**
	 * Render as the object shape accepted by `node:http`'s `request()`, where a
	 * repeated header is expressed as an array of values.
	 *
	 * @returns {Record<string, string | string[]>}
	 */
	toOutgoingHeaders() {
		/** @type {Record<string, string | string[]>} */
		const out = {};
		for (const [name, values] of this._entries) {
			out[name] = values.length === 1 ? values[0] : [...values];
		}
		return out;
	}

	/**
	 * Render as the flat array accepted by `ServerResponse#writeHead`.
	 *
	 * @returns {string[]}
	 */
	toFlatHeaders() {
		/** @type {string[]} */
		const out = [];
		for (const [name, value] of this.entries()) {
			out.push(name, value);
		}
		return out;
	}
}
