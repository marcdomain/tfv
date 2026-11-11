// Checks OpenPGP signatures on release checksum files (SHA256SUMS), with Node's own
// crypto and no extra dependency. Enough of RFC 4880/9580 for what HashiCorp, OpenTofu
// and Terragrunt publish: v4 keys and subkeys, RSA and Ed25519, detached binary
// signatures, SHA-256/384/512. Keys are bundled in ./keys, so a compromised mirror
// can't swap both a binary and its checksum file.
const crypto = require('crypto');

const HASHES = { 2: 'sha1', 8: 'sha256', 9: 'sha384', 10: 'sha512', 11: 'sha224' };
const RSA = new Set([1, 2, 3]);
const EDDSA_LEGACY = 22;
const ED25519 = 27;
const ED25519_OID = '2b06010401da470f01'; // 1.3.6.1.4.1.11591.15.1

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Armored text → bytes (the base64 between the header block and the "=crc" line).
const dearmor = (text) => {
  const m = /-----BEGIN PGP [A-Z ]+-----\r?\n([\s\S]*?)-----END PGP [A-Z ]+-----/.exec(text);
  if (!m) throw new Error('not an armored OpenPGP block');
  const lines = m[1].split(/\r?\n/);
  const blank = lines.findIndex(l => l.trim() === '');
  const body = lines.slice(blank + 1).filter(l => l && !l.startsWith('='));
  return Buffer.from(body.join(''), 'base64');
};

// Splits a binary OpenPGP stream into { tag, body } packets.
const packets = (buf) => {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const head = buf[i++];
    if (!(head & 0x80)) throw new Error('bad OpenPGP packet header');
    let tag;
    let len;
    if (head & 0x40) { // new format
      tag = head & 0x3f;
      const o = buf[i++];
      if (o < 192) len = o;
      else if (o < 224) len = ((o - 192) << 8) + buf[i++] + 192;
      else if (o === 255) { len = buf.readUInt32BE(i); i += 4; } else throw new Error('partial-length packets are not supported');
    } else { // old format
      tag = (head >> 2) & 0x0f;
      const t = head & 3;
      if (t === 0) len = buf[i++];
      else if (t === 1) { len = buf.readUInt16BE(i); i += 2; } else if (t === 2) { len = buf.readUInt32BE(i); i += 4; } else len = buf.length - i;
    }
    out.push({ tag, body: buf.subarray(i, i + len) });
    i += len;
  }
  return out;
};

// One multi-precision integer at `at`: { value, next }.
const mpi = (buf, at) => {
  const bits = buf.readUInt16BE(at);
  const bytes = Math.ceil(bits / 8);
  return { value: buf.subarray(at + 2, at + 2 + bytes), next: at + 2 + bytes };
};

const leftPad = (b, n) => (b.length >= n ? b : Buffer.concat([Buffer.alloc(n - b.length), b]));

// A v4 public key or subkey packet → { keyId, fingerprint, algo, key (KeyObject) }.
const parseKey = (body) => {
  if (body[0] !== 4) return null; // only v4 keys
  const algo = body[5];
  let key = null;
  if (RSA.has(algo)) {
    const n = mpi(body, 6);
    const e = mpi(body, n.next);
    key = crypto.createPublicKey({ key: { kty: 'RSA', n: b64url(n.value), e: b64url(e.value) }, format: 'jwk' });
  } else if (algo === EDDSA_LEGACY) {
    const oidLen = body[6];
    const oid = body.subarray(7, 7 + oidLen).toString('hex');
    if (oid !== ED25519_OID) return null;
    const point = mpi(body, 7 + oidLen).value; // 0x40 prefix + 32 bytes
    key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64url(point.subarray(point.length - 32)) }, format: 'jwk' });
  } else if (algo === ED25519) {
    key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64url(body.subarray(6, 38)) }, format: 'jwk' });
  } else {
    return null;
  }
  const fingerprint = crypto.createHash('sha1')
    .update(Buffer.from([0x99, (body.length >> 8) & 0xff, body.length & 0xff])).update(body).digest();
  return { keyId: fingerprint.subarray(12).toString('hex').toUpperCase(), fingerprint: fingerprint.toString('hex').toUpperCase(), algo, key };
};

// Every usable key and subkey in armored key files.
const loadKeys = (armored) => armored.flatMap(text => packets(dearmor(text))
  .filter(p => p.tag === 6 || p.tag === 14)
  .map(p => parseKey(p.body))
  .filter(Boolean));

const subpackets = (buf) => {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let len = buf[i++];
    if (len >= 192 && len < 255) len = ((len - 192) << 8) + buf[i++] + 192;
    else if (len === 255) { len = buf.readUInt32BE(i); i += 4; }
    out.push({ type: buf[i] & 0x7f, body: buf.subarray(i + 1, i + len) });
    i += len;
  }
  return out;
};

// A v4 signature packet → its parts.
const parseSignature = (body) => {
  if (body[0] !== 4) throw new Error(`unsupported signature version ${body[0]}`);
  const sigType = body[1];
  const algo = body[2];
  const hashAlgo = body[3];
  const hashedLen = body.readUInt16BE(4);
  const hashed = body.subarray(6, 6 + hashedLen);
  const unhashedLen = body.readUInt16BE(6 + hashedLen);
  const unhashed = body.subarray(8 + hashedLen, 8 + hashedLen + unhashedLen);
  let at = 8 + hashedLen + unhashedLen;
  const left16 = body.subarray(at, at + 2);
  at += 2;
  const issuers = new Set();
  for (const s of [...subpackets(hashed), ...subpackets(unhashed)]) {
    if (s.type === 16) issuers.add(s.body.toString('hex').toUpperCase());
    if (s.type === 33) issuers.add(s.body.subarray(1).subarray(-8).toString('hex').toUpperCase());
  }
  let sig;
  if (RSA.has(algo)) sig = { s: mpi(body, at).value };
  else if (algo === EDDSA_LEGACY) { const r = mpi(body, at); sig = { r: r.value, s: mpi(body, r.next).value }; } else if (algo === ED25519) sig = { raw: body.subarray(at, at + 64) };
  else throw new Error(`unsupported signature algorithm ${algo}`);
  return { sigType, algo, hashAlgo, trailerSource: body.subarray(0, 6 + hashedLen), left16, issuers, sig };
};

// Text signatures are made over the data with CRLF line endings.
const canonical = (data, sigType) => (sigType === 0x01 ? Buffer.from(data.toString('utf8').replace(/\r?\n/g, '\r\n')) : data);

/**
 * Verifies a detached signature over `data` with any of the keys in `armoredKeys`.
 * Returns the key id that signed it; throws when the signature doesn't check out.
 */
const verifyDetached = (data, signature, armoredKeys) => {
  const sigPacket = packets(Buffer.isBuffer(signature) ? signature : Buffer.from(signature)).find(p => p.tag === 2);
  if (!sigPacket) throw new Error('no signature found');
  const s = parseSignature(sigPacket.body);
  if (s.sigType !== 0x00 && s.sigType !== 0x01) throw new Error(`not a document signature (type ${s.sigType})`);
  const hashName = HASHES[s.hashAlgo];
  if (!hashName || hashName === 'sha1') throw new Error(`unsupported or weak hash algorithm ${s.hashAlgo}`);
  const keys = loadKeys(armoredKeys).filter(k => s.issuers.has(k.keyId));
  if (!keys.length) throw new Error(`signed by an unknown key (${[...s.issuers].join(', ') || 'no issuer'})`);

  const trailer = Buffer.alloc(6);
  trailer[0] = 4; trailer[1] = 0xff; trailer.writeUInt32BE(s.trailerSource.length, 2);
  const signed = Buffer.concat([canonical(data, s.sigType), s.trailerSource, trailer]);
  const digest = crypto.createHash(hashName).update(signed).digest();
  if (!digest.subarray(0, 2).equals(s.left16)) throw new Error('signature does not match the file');

  for (const k of keys) {
    let ok = false;
    if (RSA.has(s.algo) && RSA.has(k.algo)) {
      const n = Math.ceil(k.key.asymmetricKeyDetails.modulusLength / 8);
      ok = crypto.verify(hashName, signed, { key: k.key, padding: crypto.constants.RSA_PKCS1_PADDING }, leftPad(s.sig.s, n));
    } else if (s.algo === EDDSA_LEGACY && (k.algo === EDDSA_LEGACY || k.algo === ED25519)) {
      ok = crypto.verify(null, digest, k.key, Buffer.concat([leftPad(s.sig.r, 32), leftPad(s.sig.s, 32)]));
    } else if (s.algo === ED25519 && (k.algo === ED25519 || k.algo === EDDSA_LEGACY)) {
      ok = crypto.verify(null, digest, k.key, s.sig.raw);
    }
    if (ok) return k.keyId;
  }
  throw new Error('signature does not match the file');
};

module.exports = { verifyDetached, loadKeys, dearmor, packets };
