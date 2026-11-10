// Bridge to the teriac CLI's core library (CommonJS, ../../../lib/core).
// Loaded lazily so main.ts can set TERIAC_HOME first.
import { createRequire } from 'node:module';

export type Provider = 'terraform' | 'opentofu' | 'terragrunt';

export interface Pinned { file: string; version: string }

export interface TeriacCore {
  ensureVersion(dir: string, provider: Provider, options?: { fallback?: string }): Promise<{ provider: Provider; version: string; binary: string; source: Pinned | null }>;
  installVersion(provider: Provider, version: string, options?: object): Promise<{ provider: Provider; version: string; binary: string; alreadyInstalled: boolean }>;
  resolveExactVersion(provider: Provider, value: string): Promise<string>;
  findPinnedVersion(dir: string, provider: Provider, options?: { strict?: boolean }): Pinned | null;
  findVersionFile(dir: string, provider: Provider, options?: { strict?: boolean }): Pinned | null;
  findHclConstraint(dir: string, attribute: string): Pinned | null;
  getVersionArgs(provider: Provider): string[];
  CODES: Record<string, string>;
}

let core: TeriacCore | undefined;

export const teriac = (): TeriacCore => {
  if (!core) core = createRequire(import.meta.url)('../../../lib/core/index.js') as TeriacCore;
  return core;
};

// Hands teriac's downloader a GitHub token in-process (never via the environment, which
// Terraform runs inherit).
export const setDownloadToken = (token: string | null) => {
  (createRequire(import.meta.url)('../../../lib/utils/net.js') as { setDownloadToken: (t: string | null) => void }).setDownloadToken(token);
};
