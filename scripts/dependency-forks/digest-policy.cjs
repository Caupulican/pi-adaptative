"use strict";

/** The surrounding verifier still owns padding, OID choices, hash comparison and MD2/MD5 rules. */
function hasCanonicalDigestAlgorithm(envelope, asn1) {
	if (!Array.isArray(envelope.value) || envelope.value.length !== 2) return false;
	const algorithm = envelope.value[0];
	if (!Array.isArray(algorithm.value) || algorithm.value.length < 1 || algorithm.value.length > 2) return false;
	if (algorithm.value.length === 1) return true;
	const parameters = algorithm.value[1];
	return parameters.tagClass === asn1.Class.UNIVERSAL && parameters.type === asn1.Type.NULL &&
		parameters.constructed === false && parameters.value === "";
}

module.exports = { hasCanonicalDigestAlgorithm };
