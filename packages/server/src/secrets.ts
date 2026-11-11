// Finds things that look like secrets in Terraform output before it reaches a PR
// comment, a check run or the dashboard. Values Terraform marks as sensitive are
// already hidden; this catches the rest (a key in a tag, a token in an error...).
import type { SecretPattern } from './safety-config.ts';

interface Rule { kind: string; re: RegExp; group?: number }

// Each rule replaces the whole match, or only capture `group` (keeping the name around it).
const BUILT_IN: Rule[] = [
  { kind: 'private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { kind: 'aws-access-key', re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
  { kind: 'aws-secret-key', re: /((?:aws_?secret_?access_?key|secret_?access_?key|SecretAccessKey)["']?\s*[:=]\s*["']?)([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])/gi, group: 2 },
  { kind: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  { kind: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'slack-webhook', re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/g },
  { kind: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'stripe-key', re: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/g },
  { kind: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: 'azure-storage-key', re: /(AccountKey=)([A-Za-z0-9+/]{80,}={0,2})/g, group: 2 },
  // In plan lines: password = "hunter2". Terraform's own placeholders are left alone.
  {
    kind: 'password',
    re: /^([ \t]*[+~-]?[ \t]*"?(?:password|passwd|db_password|master_password|admin_password|secret|client_secret|api_key|apikey|access_token|auth_token|private_key)"?[ \t]*[=:][ \t]*")((?!\(sensitive|\(known after apply\))[^"\n]{4,})(")/gim,
    group: 2,
  },
];

export interface ScanResult { text: string; found: string[] }

const compile = (extra: SecretPattern[] = []): Rule[] => [
  ...BUILT_IN,
  ...extra.map(p => ({ kind: p.name, re: new RegExp(p.regex, 'g') })),
];

const label = (kind: string) => `‹redacted: ${kind}›`;

// Replaces every match with a label; `found` lists the kinds (each once).
export const scanSecrets = (text: string, extra: SecretPattern[] = []): ScanResult => {
  const found = new Set<string>();
  let out = text;
  for (const rule of compile(extra)) {
    rule.re.lastIndex = 0;
    out = out.replace(rule.re, (...m: string[]) => {
      found.add(rule.kind);
      if (rule.group === undefined) return label(rule.kind);
      // Rebuild the match with only the secret group swapped out.
      const groups = m.slice(1, -2);
      return groups.map((g, i) => (i + 1 === rule.group ? label(rule.kind) : g ?? '')).join('');
    });
  }
  return { text: out, found: [...found] };
};

export const secretNote = (found: string[]): string =>
  `🔐 ${found.length === 1 ? 'Something that looks like a secret was' : 'Things that look like secrets were'} hidden from this output (${found.join(', ')}). Check where it came from: real credentials shouldn't appear in a plan.`;
