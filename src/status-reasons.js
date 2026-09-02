/**
 * Canonical HTTP reason phrases.
 *
 * Rust's `http::StatusCode::canonical_reason()` returns `None` for unknown
 * codes and actix renders that as `<unknown status code>`; Node's
 * `http.STATUS_CODES` covers the same registry, so we defer to it and only
 * supply the fallback text.
 */

import { STATUS_CODES } from "node:http";

/** Rendered by actix when a status code has no canonical reason. */
export const UNKNOWN_REASON = "<unknown status code>";

/**
 * @param {number} status
 * @returns {string}
 */
export function statusReason(status) {
	return STATUS_CODES[status] ?? UNKNOWN_REASON;
}
