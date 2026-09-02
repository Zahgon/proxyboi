/**
 * Hand-rolled ANSI styling that reproduces the exact byte sequences emitted by
 * the `yansi` crate as used by the original Rust implementation.
 *
 * Two properties of `yansi` are deliberately preserved here:
 *
 *   1. Attributes (bold/underline) are emitted *before* the foreground colour
 *      inside a single SGR sequence, e.g. bold green is `ESC[1;32m`.
 *   2. Colouring is **always on**. `yansi` (with the feature set selected by
 *      proxyboi) performs no TTY detection and honours neither `NO_COLOR` nor
 *      `TERM=dumb`, so escape codes appear even when stdout is redirected to a
 *      file or a pipe. We match that behaviour byte for byte.
 */

const ESC = "\u001b[";

/** Reset sequence appended after every styled span. */
export const RESET = `${ESC}0m`;

/**
 * @param {string} code SGR parameter string, e.g. `"1;32"`.
 * @returns {(value: unknown) => string}
 */
function style(code) {
	const open = `${ESC}${code}m`;
	return (value) => `${open}${String(value)}${RESET}`;
}

export const red = style("31");
export const green = style("32");
export const yellow = style("33");
export const blue = style("34");
export const magenta = style("35");
export const cyan = style("36");

export const boldRed = style("1;31");
export const boldGreen = style("1;32");
export const boldBlue = style("1;34");
export const boldMagenta = style("1;35");
export const boldCyan = style("1;36");

export const underlineCyan = style("4;36");
