import { createPrivateKey } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIUOf7ch9C+gaNEp8ao/JOiGET0d8YwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDkwMjA4MjQ0NFoYDzIxMjYw
ODA5MDgyNDQ0WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDp4nx4W30zWE4AwKMM32sO9HZUS8Y/9dYv+/3aw12m
33w/9VvVHfNyEYw1U7E1KxTK5h+dyVdNhomUSkSyROOTcRynseROf6ZVnLyri10+
15U21DN2uR6l5vR3HHg5WaGvH5lQWcpj44jQBws3yXO28DnRkSdhEb1pIKxJvUZm
ArDJj8iAIJNY+hDUyUWPd0mamMScq2oXEmiMt7JiK3lPBG8GPxSry/qiS61iisd6
38ACcmYjtR9/YGXiPPB9n2nQoJJBc7Mc8AerCeZSYfAIc95RiTX1IFLhE3Ewv0S7
JxKUJiIdAK43sCe8CwN7Zyz1j6yHd6lVXLay8z/T8RexAgMBAAGjbzBtMB0GA1Ud
DgQWBBTCRJttrJhJn4XkE7dD1j8E8lK3KTAfBgNVHSMEGDAWgBTCRJttrJhJn4Xk
E7dD1j8E8lK3KTAPBgNVHRMBAf8EBTADAQH/MBoGA1UdEQQTMBGCCWxvY2FsaG9z
dIcEfwAAATANBgkqhkiG9w0BAQsFAAOCAQEAdk6KXmE7vBzIPeaTwZ6ZF5uUsWfq
YHCeM4FSqFHrUJ/g9TKMEWTfW5WkLt+1H4Omgp3q+Epq85dyGc+h8vlHXT8/cP1l
9TLQ/UQ/7irnkFwpiWInt3oyDF6ywENEtqLcrAaLbInijqABcre4wv6ymm0jbR81
5dR41+TdrkkzGKBZw1W8GUCS8WsdJhOzfOzIclsl/79jWbIeSTuYlSbp+vtJQGh3
qbuewO1HdqCay3/B4Lc+OIqammQB4DYW/0FKT/BF3MmTBDfGcXNMu6qJnmNMFlmx
LY7BTCA3FIQc/dHnUOFJeKQj9NPMxl30dzwiJgHzI9f8jxb8AcOEfGODnw==
-----END CERTIFICATE-----
`;

export const PKCS8_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDp4nx4W30zWE4A
wKMM32sO9HZUS8Y/9dYv+/3aw12m33w/9VvVHfNyEYw1U7E1KxTK5h+dyVdNhomU
SkSyROOTcRynseROf6ZVnLyri10+15U21DN2uR6l5vR3HHg5WaGvH5lQWcpj44jQ
Bws3yXO28DnRkSdhEb1pIKxJvUZmArDJj8iAIJNY+hDUyUWPd0mamMScq2oXEmiM
t7JiK3lPBG8GPxSry/qiS61iisd638ACcmYjtR9/YGXiPPB9n2nQoJJBc7Mc8Aer
CeZSYfAIc95RiTX1IFLhE3Ewv0S7JxKUJiIdAK43sCe8CwN7Zyz1j6yHd6lVXLay
8z/T8RexAgMBAAECggEABpHhbTTKWtfRHOF5lO5ITBBsQoD8hV581raT/cIdRP/r
iOBm1d1BhLLEyMnB/6H9s4g0RJD9qlk/BBxOM5WlOE4eg7WG1iYhr2udWZ2q7g2v
TMChsXQQ1YGcCY9V/mSJ7bB5Tvly9fl5j09YDJ7Fd/DlruL/SwJHYqFP20nyDmt3
K6KZfItPtMIlY0u3amFOvfewLeEXiepaL8PFAS9MawLhHHS0A2z93UGrTa6FQwSW
O0wHcYODcp6l5y9E2FVao32C6LgopxsZQzrHxjwiWCzfaenKDrSodGaM+ZAhsZ1w
Oa2ioKnQqq3RSuhwIzkYGohyZip//Ox4q1ik1cyVAQKBgQD+tpQQVHIHZHEmGcVY
WVdD4Tb+Db/25kaJGjcDSoDqiKlOV/m9Y6wfIJprIWUtHdsPx0cFT9+t97SOztXY
LKY7p+gHs1bfqIRwUZ82dFgnTgPks6l2Zpokh1f/gz3TFMt8VkasEvfoFfdtF2O9
qtQGnDJcAqi9WxI91nxvrDL8uwKBgQDrEPhjvdx7t2sa7DQKVcNE6Ka+t3JJnGDE
QdaIL83V+qyuYnftDiLRtInaCK45bfjNCm4B45YP9Q6EEo14oiPTieC/WWZR/Ilh
Zc/EJLFs5/YePERdp9TkD2ZxZnKo5lj5ovKPRhQ8vOS9v7N6o5PMt0JjKmjD8X2n
SITKvnMMgwKBgQDPu4Xr/4L0BnXFVhU9pbdm8+GOtxYNPebe4BNnyrZzELvL2jIi
xIxW4pctshG7BvNm3eZNLcRGNJP8ODHtWRTF6H1y8k9ynxRMKjVICwDuJVFFj0Uw
/CLQkdUx3Q5p/TarlA2VPu8SR///56h/wjejoHXt1nlZ3VF2P1xDE1SOCwKBgB9q
ojf6bRhf2EG95eqnsbRo/7gnnm+2Jby1K+4BrZn2qdOYt3yIUiEC5xWr6VUlnIYS
6cb42tqBHxKJxDymNvGT0OTiFunIPbg1ukH1wXzTt7IszdpSjwJ4CHIJhjOKrcOX
gqGhdRz1BgFSOLOgXyWSLJ5CUcQ2Z1vPNmg+cfPvAoGBAKz61xR/XQqMl29RuabY
tCruOeykTp/uFgdweBRLruPKccfuJKJvMzcAskxzB5kojqXd3yNAX4CllwVP3mEN
SQIPI+0KHLCZFdkE3q6idTlNauN0Bb4JaFL2vJsjW4HFiYEd+6CrAFBhhcSLeVqg
cMtZtTdExotUpbeedycfGnrs
-----END PRIVATE KEY-----
`;

const keyObject = createPrivateKey(PKCS8_KEY_PEM);

export const PKCS1_KEY_PEM = keyObject
	.export({ type: "pkcs1", format: "pem" })
	.toString();

export const ENCRYPTED_KEY_PEM = keyObject
	.export({
		type: "pkcs8",
		format: "pem",
		cipher: "aes-256-cbc",
		passphrase: "proxyboi",
	})
	.toString();

/**
 * Replace the leading base64 of every payload line with characters outside the
 * alphabet, so the section still has both marks but no longer decodes.
 *
 * @param {string} pem
 * @returns {string}
 */
export function corrupt(pem) {
	return pem
		.split("\n")
		.map((line) =>
			line === "" || line.startsWith("-----")
				? line
				: `!!!!${line.slice(4)}`,
		)
		.join("\n");
}

/**
 * @param {string} name
 * @param {string} contents
 * @returns {string} path of a freshly written temporary PEM file
 */
export function writePem(name, contents) {
	const path = join(mkdtempSync(join(tmpdir(), "proxyboi-tls-")), name);
	writeFileSync(path, contents);
	return path;
}
