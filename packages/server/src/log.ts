// JSON-lines logger plus secret redaction for anything that leaves the
// server (logs, PR comments, check runs, the dashboard).

const secrets = new Set<string>();

// Values shorter than this are too likely to appear by accident.
const MIN_SECRET = 6;
const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_?KEY/i;

export const addSecret = (value: string | undefined | null): void => {
  if (value && value.length >= MIN_SECRET) secrets.add(value);
};

// Registers every env value whose name looks secret (AWS_SECRET_ACCESS_KEY, ...).
export const addSecretsFromEnv = (env: NodeJS.ProcessEnv): void => {
  for (const [name, value] of Object.entries(env)) {
    if (SECRET_NAME.test(name)) addSecret(value);
  }
};

export const redact = (text: string): string => {
  let out = text;
  for (const s of secrets) {
    if (out.includes(s)) out = out.split(s).join('***');
  }
  return out;
};

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(process.env.TFV_LOG_LEVEL as Level) || 'info'] ?? 20;

const write = (level: Level, msg: string, fields: Record<string, unknown> = {}) => {
  if (ORDER[level] < threshold) return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields }, (_k, v) =>
    v instanceof Error ? { message: v.message, code: (v as { code?: string }).code } : v);
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(redact(line) + '\n');
};

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => write('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write('error', msg, fields),
};
