const http = require('http');
const https = require('https');
const { env } = require('./env');

// Corporate / offline mirrors. Each env var replaces one upstream host and
// keeps the rest of the path, which is how Artifactory/Nexus remote repos
// mirror these sites. Credentials can go in the URL: https://user:token@host
const MIRRORS = [
  ['https://releases.hashicorp.com', 'HASHICORP_MIRROR'], // terraform (TERIAC_HASHICORP_MIRROR)
  ['https://github.com', 'GITHUB_MIRROR'],                // opentofu, terragrunt (TERIAC_GITHUB_MIRROR)
];

const applyMirror = (url) => {
  for (const [host, envVar] of MIRRORS) {
    const mirror = env(envVar);
    if (mirror && url.startsWith(`${host}/`)) {
      return mirror.replace(/\/+$/, '') + url.slice(host.length);
    }
  }
  return url;
};

// Internal mirrors are often plain http.
const clientFor = (url) => (url.startsWith('http://') ? http : https);

module.exports = { applyMirror, clientFor };
