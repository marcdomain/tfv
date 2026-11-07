// Prometheus text-format metrics, no client library needed.
const counters = new Map<string, number>();
const sums = new Map<string, number>();

const key = (name: string, labels: Record<string, string>) =>
  `${name}{${Object.entries(labels).map(([k, v]) => `${k}="${v.replace(/["\\\n]/g, '_')}"`).join(',')}}`;

const inc = (map: Map<string, number>, k: string, by = 1) => map.set(k, (map.get(k) ?? 0) + by);

export const metrics = {
  webhook(platform: string, kind: string) {
    inc(counters, key('tfv_webhooks_total', { platform, kind }));
  },
  observeRun(kind: string, status: string, ms: number) {
    inc(counters, key('tfv_runs_total', { kind, status }));
    inc(sums, key('tfv_run_seconds_sum', { kind }), ms / 1000);
    inc(sums, key('tfv_run_seconds_count', { kind }));
  },
  render(extra: Record<string, number> = {}): string {
    const lines = [
      '# HELP tfv_webhooks_total Webhooks received.',
      '# TYPE tfv_webhooks_total counter',
      '# HELP tfv_runs_total Plan and apply runs by result.',
      '# TYPE tfv_runs_total counter',
      '# HELP tfv_run_seconds Time spent per run.',
      '# TYPE tfv_run_seconds summary',
    ];
    for (const [k, v] of counters) lines.push(`${k} ${v}`);
    for (const [k, v] of sums) lines.push(`${k.replace('_sum{', '_sum{').replace('_count{', '_count{')} ${v}`);
    for (const [k, v] of Object.entries(extra)) lines.push(`${k} ${v}`);
    return lines.join('\n') + '\n';
  },
};
