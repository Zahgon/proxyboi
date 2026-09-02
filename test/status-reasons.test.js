import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { UNKNOWN_REASON, statusReason } from "../src/status-reasons.js";

describe("statusReason", () => {
	it("returns the canonical reason phrase", () => {
		assert.equal(statusReason(200), "OK");
		assert.equal(statusReason(101), "Switching Protocols");
		assert.equal(statusReason(204), "No Content");
		assert.equal(statusReason(304), "Not Modified");
		assert.equal(statusReason(413), "Payload Too Large");
		assert.equal(statusReason(500), "Internal Server Error");
	});

	it("falls back to actix's placeholder for unregistered codes", () => {
		assert.equal(UNKNOWN_REASON, "<unknown status code>");
		assert.equal(statusReason(599), UNKNOWN_REASON);
		assert.equal(statusReason(299), UNKNOWN_REASON);
	});
});
