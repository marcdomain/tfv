const http = require('http');
const https = require('https');

// Corporate / offline mirrors. Each env var replaces one upstream host and
// keeps the rest of the path, which is how Artifactory/Nexus remote repos
// mirror these sites. Credentials can go in the URL: https://user:token@host
const MIRRORS = [
  ['https://releases.hashicorp.com', 'TFV_HASHICORP_MIRROR'], // terraform
  ['https://github.com', 'TFV_GITHUB_MIRROR'],                // opentofu, terragrunt
];

const applyMirror = (url) => {
  for (const [host, envVar] of MIRRORS) {
    const mirror = process.env[envVar];
    if (mirror && url.startsWith(`${host}/`)) {
      return mirror.replace(/\/+$/, '') + url.slice(host.length);
    }
  }
  return url;
};

// Internal mirrors are often plain http.
const clientFor = (url) => (url.startsWith('http://') ? http : https);

module.exports = { applyMirror, clientFor };
