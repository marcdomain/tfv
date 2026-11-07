// Serves people's avatars from this server so the dashboard loads nothing
// from third parties (strict CSP, air-gapped networks). Fetched from the
// platform on first use, cached on disk for a day; misses fall back to initials.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Platform } from './vcs/types.ts';

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const DAY = 86_400_000;
const MAX_BYTES = 256 * 1024;

// Where a platform keeps avatars, or null if it has no public per-login URL.
export const avatarSource = (platform: Platform, host: string, login: string): string | null =>
  platform === 'github' && LOGIN.test(login) ? `https://${host}/${encodeURIComponent(login)}.png?size=80` : null;

// The dashboard's URL for someone's avatar, or null when there's none to fetch.
export const avatarPath = (platform: Platform, host: string, login: string | null | undefined): string | null =>
  login && avatarSource(platform, host, login) ? `/avatars/${encodeURIComponent(host)}/${encodeURIComponent(login)}` : null;

export class Avatars {
  private dir: string;
  private hosts: Record<string, Platform>;
  private fetchImpl: typeof fetch;
  private misses = new Map<string, number>();

  constructor(dataDir: string, hosts: Record<string, Platform>, fetchImpl: typeof fetch = fetch) {
    this.dir = join(dataDir, 'avatars');
    this.hosts = hosts;
    this.fetchImpl = fetchImpl;
  }

  // Only hosts tfv is configured for: never an open image proxy.
  async get(host: string, login: string): Promise<{ type: string; body: Buffer } | null> {
    const platform = this.hosts[host];
    const source = platform ? avatarSource(platform, host, login) : null;
    if (!source) return null;
    const key = `${host}/${login.toLowerCase()}`;
    const file = join(this.dir, host, `${login.toLowerCase()}.img`);
    try {
      if (Date.now() - statSync(file).mtimeMs < DAY) {
        const body = readFileSync(file);
        return { type: body[0] === 0x89 ? 'image/png' : 'image/jpeg', body };
      }
    } catch { /* not cached yet */ }
    if ((this.misses.get(key) ?? 0) > Date.now() - DAY / 24) return null;
    try {
      const res = await this.fetchImpl(source, { signal: AbortSignal.timeout(5000), redirect: 'follow' });
      const type = res.headers.get('content-type') ?? '';
      const body = Buffer.from(await res.arrayBuffer());
      if (!res.ok || !/^image\/(png|jpeg)$/.test(type) || body.length > MAX_BYTES) throw new Error('not an avatar');
      mkdirSync(join(this.dir, host), { recursive: true });
      writeFileSync(file, body);
      return { type, body };
    } catch {
      this.misses.set(key, Date.now());
      return null;
    }
  }
}
