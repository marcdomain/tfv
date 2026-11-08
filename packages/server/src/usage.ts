// Resource usage of a run: CPU time, peak memory and peak process count of the
// Terraform/Terragrunt process and everything it starts (provider plugins).
//
// Cheap by design: while a command runs it reads a few small files under /proc,
// soon after start (50 ms, 250 ms, 1 s) and then every 2 seconds (Linux only;
// elsewhere it records nothing). No extra processes, no native modules.
import { readdirSync, readFileSync, existsSync } from 'node:fs';

export interface Usage {
  cpuSeconds: number;      // user + system CPU of the whole process tree
  peakMemory: number;      // highest total resident memory seen, in bytes
  peakProcesses: number;   // most processes in the tree at once
  quick?: boolean;         // finished before it could be measured (well under a second)
}

const SUPPORTED = existsSync('/proc/self/stat');
const TICKS = 100;         // USER_HZ: 100 on every Linux build Node supports
const PAGE = 4096;
const EARLY_MS = [50, 250, 1000];
const INTERVAL_MS = 2000;

interface Stat { pid: number; ppid: number; cpu: number; rss: number }

// /proc/<pid>/stat. The command name may contain spaces, so fields are counted after ")".
const readStat = (pid: string): Stat | null => {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const f = text.slice(text.lastIndexOf(')') + 2).split(' ');
    // f[0] is field 3 (state): ppid is field 4, utime 14, stime 15, rss 24.
    return { pid: Number(pid), ppid: Number(f[1]), cpu: (Number(f[11]) + Number(f[12])) / TICKS, rss: Number(f[21]) * PAGE };
  } catch {
    return null; // the process ended between listing and reading
  }
};

// Samples one process tree until stopped.
export class UsageSampler {
  private root: number;
  private timer: NodeJS.Timeout | null = null;
  private early: NodeJS.Timeout[] = [];
  private measurable = SUPPORTED;
  private cpu = new Map<number, number>();   // last CPU seen per process (kept after it exits)
  private peakMemory = 0;
  private peakProcesses = 0;

  constructor(root: number) {
    this.root = root;
    if (!SUPPORTED) return;
    // Early looks catch short commands; then a steady, cheap interval.
    this.early = EARLY_MS.map(ms => { const t = setTimeout(() => this.sample(), ms); t.unref(); return t; });
    this.timer = setInterval(() => this.sample(), INTERVAL_MS);
    this.timer.unref();
  }

  private sample() {
    const all = new Map<number, Stat>();
    for (const name of readdirSync('/proc')) {
      if (name.charCodeAt(0) < 48 || name.charCodeAt(0) > 57) continue; // numeric dirs only
      const s = readStat(name);
      if (s) all.set(s.pid, s);
    }
    // The root and everything descended from it.
    const tree: Stat[] = [];
    const inTree = new Set<number>([this.root]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const s of all.values()) {
        if (!inTree.has(s.pid) && inTree.has(s.ppid)) { inTree.add(s.pid); grew = true; }
      }
    }
    for (const pid of inTree) { const s = all.get(pid); if (s) tree.push(s); }
    if (!tree.length) return;
    let memory = 0;
    for (const s of tree) {
      memory += s.rss;
      this.cpu.set(s.pid, Math.max(this.cpu.get(s.pid) ?? 0, s.cpu));
    }
    this.peakMemory = Math.max(this.peakMemory, memory);
    this.peakProcesses = Math.max(this.peakProcesses, tree.length);
  }

  // Stops sampling. Null when it can't measure (not Linux); a command that ended
  // before the first look is reported as quick, with nothing measurable.
  stop(): Usage | null {
    if (this.timer) clearInterval(this.timer);
    this.early.forEach(clearTimeout);
    this.timer = null;
    if (!this.measurable) return null;
    if (!this.cpu.size) return { cpuSeconds: 0, peakMemory: 0, peakProcesses: 1, quick: true };
    const cpuSeconds = [...this.cpu.values()].reduce((a, b) => a + b, 0);
    return { cpuSeconds: Math.round(cpuSeconds * 100) / 100, peakMemory: this.peakMemory, peakProcesses: this.peakProcesses };
  }
}

// Usage of several commands in one run (init, plan, show): CPU adds up, peaks are peaks.
export const combineUsage = (a: Usage | null, b: Usage | null): Usage | null => {
  if (!a) return b;
  if (!b) return a;
  const out: Usage = {
    cpuSeconds: Math.round((a.cpuSeconds + b.cpuSeconds) * 100) / 100,
    peakMemory: Math.max(a.peakMemory, b.peakMemory),
    peakProcesses: Math.max(a.peakProcesses, b.peakProcesses),
  };
  if (a.quick && b.quick) out.quick = true;
  return out;
};

export const usageSupported = () => SUPPORTED;
