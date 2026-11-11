// A risk level for each plan, from fixed rules (the same plan always gets the same
// score): what is destroyed or replaced, identity and network changes, production,
// size, and policy findings. Shown on the PR; high levels can need an extra approval.
import type { PlanSummary } from './render.ts';
import type { RiskConfig, RiskLevel } from './safety-config.ts';
import { RISK_LEVELS, DEFAULT_SIZE_LIMITS } from './safety-config.ts';
import { matchGlob } from './glob.ts';
import { addressParts } from './blame.ts';

export interface Risk { level: RiskLevel; reasons: string[] }

// Losing one of these loses data or takes a whole system down.
const STATEFUL = [
  /^aws_(db_instance|rds_cluster|rds_global_cluster|dynamodb_table|s3_bucket|efs_file_system|elasticache_(cluster|replication_group)|redshift_cluster|docdb_cluster|neptune_cluster|opensearch_domain|elasticsearch_domain|kinesis_stream|msk_cluster|ebs_volume|backup_vault|kms_key|route53_zone|eks_cluster|secretsmanager_secret|cloudtrail|ecr_repository|memorydb_cluster|timestreamwrite_database)$/,
  /^google_(sql_database_instance|sql_database|storage_bucket|bigquery_dataset|bigquery_table|spanner_instance|spanner_database|bigtable_instance|container_cluster|kms_crypto_key|kms_key_ring|dns_managed_zone|filestore_instance|redis_instance|secret_manager_secret|alloydb_cluster)$/,
  /^azurerm_(.*sql.*(server|database|instance)|cosmosdb_account|storage_account|kubernetes_cluster|key_vault|key_vault_key|dns_zone|private_dns_zone|redis_cache|managed_disk|recovery_services_vault|postgresql_flexible_server|mysql_flexible_server)$/,
  /^(kubernetes_persistent_volume(_claim)?(_v1)?|kubernetes_namespace(_v1)?|helm_release)$/,
];
const IDENTITY = /(^|_)(iam|role|policy|policies|permission|permissions|grant|access_key|user_policy|service_account|assume|federated|identity|rbac|cluster_role|key_vault_access)(_|$)/;
const NETWORK = /(^|_)(security_group|network_acl|firewall|route_table|route|vpc_peering|transit_gateway|nat_gateway|internet_gateway|network_security|nsg|subnet|vpc|lb_listener|waf)(_|$)/;

const DEFAULT_PRODUCTION = ['prod', 'prod/**', '**/prod', '**/prod/**', 'production', 'production/**', '**/production', '**/production/**', '**/prd/**', 'prd/**'];

const rank = (l: RiskLevel) => RISK_LEVELS.indexOf(l);
export const atLeast = (have: RiskLevel, need: RiskLevel) => rank(have) >= rank(need);

const typeOf = (address: string): string => {
  const parts = addressParts(address);
  // Skip module.<name> pairs, and "data".
  let i = 0;
  while (parts[i] === 'module') i += 2;
  if (parts[i] === 'data') i++;
  return parts[i] ?? '';
};

export const isProduction = (project: { name: string; dir: string }, cfg?: RiskConfig): boolean =>
  (cfg?.production ?? DEFAULT_PRODUCTION).some(g => matchGlob(g, project.name) || matchGlob(g, project.dir));

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const assessRisk = (
  summary: PlanSummary | null,
  project: { name: string; dir: string },
  findings: { severity: string }[] = [],
  cfg?: RiskConfig,
): Risk | null => {
  if (!summary || summary.noChanges) return null;
  const prod = isProduction(project, cfg);
  let level: RiskLevel = 'low';
  const reasons: string[] = [];
  const raise = (l: RiskLevel, why: string) => {
    if (rank(l) > rank(level)) level = l;
    reasons.push(why);
  };

  const destructive = summary.changes.filter(c => c.action === 'delete' || c.action === 'replace');
  const extraStateful = cfg?.stateful_types ?? [];
  const isStateful = (type: string) => STATEFUL.some(re => re.test(type)) || extraStateful.some(g => matchGlob(g, type));
  const stateful = destructive.filter(c => isStateful(typeOf(c.address)));
  const otherDestructive = destructive.length - stateful.length;
  if (stateful.length) {
    const names = stateful.slice(0, 3).map(c => `\`${c.address}\``).join(', ') + (stateful.length > 3 ? ', …' : '');
    raise(prod ? 'critical' : 'high', `destroys or replaces ${plural(stateful.length, 'stateful resource')} (${names})${prod ? ' in production' : ''}`);
  }
  if (otherDestructive) raise(prod ? 'high' : 'medium', `destroys or replaces ${plural(otherDestructive, 'resource')}${prod ? ' in production' : ''}`);

  const identity = summary.changes.filter(c => IDENTITY.test(typeOf(c.address)));
  if (identity.length) raise(prod ? 'high' : 'medium', `changes ${plural(identity.length, 'access or permission resource')}`);
  const network = summary.changes.filter(c => NETWORK.test(typeOf(c.address)) && !identity.includes(c));
  if (network.length) raise('medium', `changes ${plural(network.length, 'network resource')}`);

  const n = summary.changes.length;
  const limits = { ...DEFAULT_SIZE_LIMITS, ...cfg?.size_limits };
  if (n > limits.high) raise('high', `changes ${n} resources at once`);
  else if (n > limits.medium) raise('medium', `changes ${n} resources at once`);

  const severe = findings.filter(f => f.severity === 'critical' || f.severity === 'high').length;
  const medium = findings.filter(f => f.severity === 'medium').length;
  if (severe) raise('high', `${plural(severe, 'high-severity policy finding')}`);
  else if (medium) raise('medium', `${plural(medium, 'policy finding')}`);

  if (prod && level === 'low') raise('medium', 'changes production');
  return { level, reasons };
};

export const RISK_BADGE: Record<RiskLevel, string> = { low: '🟢 Low', medium: '🟡 Medium', high: '🟠 High', critical: '🔴 Critical' };

// The extra approval a risk level needs, if any: the rule for the highest level at or below it.
export const extraApprovalFor = (level: RiskLevel, cfg?: RiskConfig) => {
  let rule = null;
  for (const l of RISK_LEVELS) {
    const r = cfg?.extra_approval?.[l];
    if (r && atLeast(level, l)) rule = { ...r, level: l };
  }
  return rule as (typeof rule & { level: RiskLevel }) | null;
};
