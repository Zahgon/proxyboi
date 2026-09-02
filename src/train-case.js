/**
 * Port of the `Inflector` crate's `to_train_case()` as used by proxyboi to
 * pretty-print header names in verbose logs (`content-type` -> `Content-Type`).
 *
 * The algorithm was reverse-engineered from the Rust binary and reproduces its
 * word-boundary rules exactly:
 *
 *   - any non-alphanumeric character terminates a word and is dropped,
 *   - a lowercase letter followed by an uppercase letter starts a new word,
 *   - a **digit followed by a letter** starts a new word,
 *   - a letter followed by a digit does *not* start a new word.
 *
 * Each resulting word is then capitalised (first character upper, remainder
 * lower) and the words are joined with `-`.
 *
 * Verified against the Rust oracle:
 *   content-type       -> Content-Type
 *   x-forwarded-for    -> X-Forwarded-For
 *   content-md5        -> Content-Md5
 *   sec-ch-ua          -> Sec-Ch-Ua
 *   x-b3-traceid       -> X-B3-Traceid
 *   x-a1b2             -> X-A1-B2
 *   dnt                -> Dnt
 */

const ALPHANUMERIC = /[0-9A-Za-z]/;
const DIGIT = /[0-9]/;
const LOWER = /[a-z]/;
const UPPER = /[A-Z]/;
const LETTER = /[A-Za-z]/;

/**
 * Split an identifier into Inflector's notion of words.
 *
 * @param {string} input
 * @returns {string[]}
 */
export function splitWords(input) {
	/** @type {string[]} */
	const words = [];
	let current = "";
	let previous = "";

	for (const char of input) {
		if (!ALPHANUMERIC.test(char)) {
			if (current.length > 0) {
				words.push(current);
				current = "";
			}
			previous = "";
			continue;
		}

		if (current.length > 0) {
			const lowerToUpper = LOWER.test(previous) && UPPER.test(char);
			const digitToLetter = DIGIT.test(previous) && LETTER.test(char);
			if (lowerToUpper || digitToLetter) {
				words.push(current);
				current = "";
			}
		}

		current += char;
		previous = char;
	}

	if (current.length > 0) {
		words.push(current);
	}

	return words;
}

/**
 * Convert an arbitrary identifier to `Train-Case`.
 *
 * @param {string} input
 * @returns {string}
 */
export function toTrainCase(input) {
	return splitWords(input)
		.map(
			(word) =>
				word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
		)
		.join("-");
}
