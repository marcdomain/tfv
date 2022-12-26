exports.formatVersions = (content) => {
  const pattern = /(>terraform_).*(?=<\/a>)/g;
  const versions = content.match(pattern).map(v => v.replace('>terraform_', ''));

  return versions;
}
