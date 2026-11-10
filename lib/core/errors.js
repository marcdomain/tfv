// Errors thrown by teriac/core. `code` lets callers (the CLI, teriac-server)
// decide how to report each case without parsing messages.
class TeriacError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TeriacError';
    this.code = code;
    this.details = details;
  }
}

const CODES = {
  VERSION_NOT_FOUND: 'VERSION_NOT_FOUND',     // requested version does not exist
  VERSION_LIST_UNAVAILABLE: 'VERSION_LIST_UNAVAILABLE',
  DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
  CHECKSUM_FAILED: 'CHECKSUM_FAILED',
  NO_VERSION: 'NO_VERSION',                   // nothing pins a version in this dir
  NO_MATCH: 'NO_MATCH',                       // no version satisfies the constraint
};

module.exports = { TeriacError, CODES };
