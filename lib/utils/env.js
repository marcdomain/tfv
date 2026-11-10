// Settings come from TERIAC_* environment variables.
const env = (name, fallback) => {
  const value = process.env[`TERIAC_${name}`];
  return value === undefined || value === '' ? fallback : value;
};

module.exports = { env };
