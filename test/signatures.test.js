// Release checksum files must be signed by the tool's vendor: real signatures from
// HashiCorp, OpenTofu and Terragrunt, a tampered file, the wrong key, and the install
// path (served from a local mirror) refusing a forged checksum file.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { verifyDetached, loadKeys } = require('../lib/core/pgp');
const { verifySignature } = require('../lib/core/install');
const { TeriacError } = require('../lib/core/errors');

const F = path.join(__dirname, 'fixtures', 'pgp');
const KEYS = path.join(__dirname, '..', 'lib', 'core', 'keys');
const key = (name) => fs.readFileSync(path.join(KEYS, `${name}.asc`), 'utf8');
const read = (f) => fs.readFileSync(path.join(F, f));

describe('OpenPGP signatures', () => {
  test.each([
    ['terraform 1.9.8 (RSA subkey, SHA-256)', 'tf', 'hashicorp', 'C820C6D5CD27AB87'],
    ['opentofu 1.8.5 (RSA, SHA-512)', 'tofu', 'opentofu', '0C0AF313E5FD9F80'],
    ['terragrunt 1.2.1 (Ed25519, SHA-512)', 'tg', 'terragrunt', '577774ACA847CC49'],
  ])('%s verifies', (_name, f, k, id) => {
    expect(verifyDetached(read(`${f}.sums`), read(`${f}.sig`), [key(k)])).toBe(id);
  });

  test.each([['tf', 'hashicorp'], ['tofu', 'opentofu'], ['tg', 'terragrunt']])('a changed %s checksum file is refused', (f, k) => {
    const sums = Buffer.from(read(`${f}.sums`));
    sums[5] ^= 1;
    expect(() => verifyDetached(sums, read(`${f}.sig`), [key(k)])).toThrow(/does not match/);
  });

  test('a signature from another key is refused', () => {
    expect(() => verifyDetached(read('tf.sums'), read('tf.sig'), [key('opentofu')])).toThrow(/unknown key \(C820C6D5CD27AB87\)/);
  });

  test('a damaged signature is refused', () => {
    const sig = Buffer.from(read('tofu.sig'));
    sig[sig.length - 3] ^= 0xff;
    expect(() => verifyDetached(read('tofu.sums'), sig, [key('opentofu')])).toThrow();
    expect(() => verifyDetached(read('tofu.sums'), Buffer.from('not a signature'), [key('opentofu')])).toThrow();
  });

  test('bundled keys have the vendors\' published fingerprints', () => {
    const fp = (k) => loadKeys([key(k)])[0].fingerprint;
    expect(fp('hashicorp')).toBe('C874011F0AB405110D02105534365D9472D7468F');
    expect(fp('opentofu')).toBe('E3E6E43D84CB852EADB0051D0C0AF313E5FD9F80');
    expect(fp('terragrunt')).toBe('68C80F86DF98E710C0F22E2E577774ACA847CC49');
  });
});

describe('install checks the signature (via a local mirror)', () => {
  let server;
  let routes;
  beforeAll(async () => {
    process.env.TERIAC_RETRY_DELAY_MS = '1';
    server = http.createServer((req, res) => {
      const body = routes[req.url];
      if (body === undefined) { res.writeHead(404); return res.end('nope'); }
      res.writeHead(200); res.end(body);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    process.env.TERIAC_HASHICORP_MIRROR = base;
    process.env.TERIAC_GITHUB_MIRROR = base;
  });
  afterAll(() => {
    for (const k of ['TERIAC_RETRY_DELAY_MS', 'TERIAC_HASHICORP_MIRROR', 'TERIAC_GITHUB_MIRROR', 'TERIAC_VERIFY_SIGNATURES']) delete process.env[k];
    server.close();
  });
  beforeEach(() => { routes = {}; delete process.env.TERIAC_VERIFY_SIGNATURES; });

  const tfSums = () => read('tf.sums').toString('utf8');
  const serveTerraform = (sums, sig = read('tf.sig')) => {
    routes['/terraform/1.9.8/terraform_1.9.8_SHA256SUMS'] = sums;
    if (sig) routes['/terraform/1.9.8/terraform_1.9.8_SHA256SUMS.sig'] = sig;
  };

  test('the real checksum file and signature pass', async () => {
    serveTerraform(tfSums());
    await expect(verifySignature('terraform', '1.9.8', tfSums())).resolves.toBe('verified');
  });

  test('a forged checksum file (a mirror swapping a binary) is refused', async () => {
    const forged = tfSums().replace(/^[0-9a-f]{64}/, 'f'.repeat(64));
    serveTerraform(forged);
    const err = await verifySignature('terraform', '1.9.8', forged).catch(e => e);
    expect(err).toBeInstanceOf(TeriacError);
    expect(err.code).toBe('SIGNATURE_FAILED');
    expect(err.message).toMatch(/not signed by HashiCorp.*refused/);
  });

  test('a missing signature is refused for Terraform, with a hint for mirrors', async () => {
    serveTerraform(tfSums(), null);
    await expect(verifySignature('terraform', '1.9.8', tfSums())).rejects.toThrow(/No signature found.*TERIAC_VERIFY_SIGNATURES=false/);
  });

  test('old Terragrunt releases without a signature fall back to the checksum', async () => {
    const logs = [];
    await expect(verifySignature('terragrunt', '0.83.2', 'x', (lvl, msg) => logs.push(msg))).resolves.toBe('unsigned');
    expect(logs[0]).toMatch(/publishes no signature/);
  });

  test('TERIAC_VERIFY_SIGNATURES=false turns the check off', async () => {
    process.env.TERIAC_VERIFY_SIGNATURES = 'false';
    await expect(verifySignature('terraform', '1.9.8', 'anything')).resolves.toBe('off');
  });
});
