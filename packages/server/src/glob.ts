// Small glob matcher for project paths and repo ids.
//   **   any number of path segments (including none)
//   *    anything except "/"
//   ?    one character except "/"
const cache = new Map<string, RegExp>();

export const globToRegExp = (glob: string): RegExp => {
  let re = cache.get(glob);
  if (re) return re;
  let src = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      // "**/" matches zero or more directories; a trailing "**" matches everything.
      if (glob[i + 2] === '/') { src += '(?:.*/)?'; i += 2; } else { src += '.*'; i += 1; }
    } else if (c === '*') src += '[^/]*';
    else if (c === '?') src += '[^/]';
    else src += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  re = new RegExp(`^${src}$`);
  cache.set(glob, re);
  return re;
};

export const matchGlob = (glob: string, path: string): boolean => globToRegExp(glob).test(path);
