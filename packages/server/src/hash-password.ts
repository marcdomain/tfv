// Prints a password hash for dashboard users (repos.yaml `dashboard.users`).
// Usage: node packages/server/src/hash-password.ts        (asks for the password)
//        printf %s "$PASSWORD" | node packages/server/src/hash-password.ts
import { createInterface } from 'node:readline';
import { hashPassword } from './auth.ts';

const read = async (): Promise<string> => {
  if (!process.stdin.isTTY) {
    let s = '';
    for await (const c of process.stdin) s += c;
    return s.replace(/\r?\n$/, '');
  }
  process.stderr.write('Password: ');
  const rl = createInterface({ input: process.stdin, terminal: true });
  // Don't echo what is typed.
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
  const line = await new Promise<string>(r => rl.question('', r));
  rl.close();
  process.stderr.write('\n');
  return line;
};

const password = await read();
if (password.length < 12) {
  process.stderr.write('Use at least 12 characters.\n');
  process.exit(1);
}
console.log(hashPassword(password));
