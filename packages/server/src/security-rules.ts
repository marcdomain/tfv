// Built-in security rules for AWS, run on every plan when `policies.builtin: [security]`
// is set. They report through the normal policy checks, so audit/enforce, --override
// and the dashboard's findings tab all apply. `policies.disable` turns single rules off.
import type { Finding, Severity } from './policies.ts';

type Values = Record<string, any>;
interface Change { address: string; type: string; action: string; before: Values | null; after: Values | null; unknown: Values }
interface Rule { name: string; severity: Severity; check: (c: Change) => string | null }

const OPEN_V4 = '0.0.0.0/0';
const OPEN_V6 = '::/0';
const WEB_PORTS = new Set([80, 443]);

const actionOf = (actions: string[]): string => {
  const a = actions.join(',');
  return a === 'delete,create' || a === 'create,delete' ? 'replace' : a;
};

const known = (c: Change, attr: string) => c.unknown?.[attr] !== true;
const parseJson = (v: unknown): any => {
  if (typeof v !== 'string') return v && typeof v === 'object' ? v : null;
  try { return JSON.parse(v); } catch { return null; }
};
const list = <T>(v: T | T[] | undefined | null): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

// Ports a rule opens, as a readable range; only 80/443 counts as "web".
const onlyWeb = (from: unknown, to: unknown, protocol: unknown) => {
  if (protocol === '-1' || protocol === 'all') return false;
  const f = Number(from), t = Number(to);
  if (!Number.isFinite(f) || !Number.isFinite(t)) return false;
  if (f !== t) return false;
  return WEB_PORTS.has(f);
};
const portText = (from: unknown, to: unknown, protocol: unknown) =>
  protocol === '-1' || protocol === 'all' ? 'all ports' : Number(from) === Number(to) ? `port ${from}` : `ports ${from}-${to}`;

// Statements in an IAM or bucket policy document.
const statements = (doc: any): any[] => list(doc?.Statement);
const allows = (s: any) => (s?.Effect ?? 'Allow') === 'Allow';
const isStar = (v: unknown) => list(v as string | string[]).some(x => x === '*');

const RULES: Rule[] = [
  {
    name: 'aws-s3-public-acl', severity: 'high',
    check: c => (/^aws_s3_bucket(_acl)?$/.test(c.type) && known(c, 'acl') && ['public-read', 'public-read-write', 'authenticated-read'].includes(c.after?.acl)
      ? `bucket ACL "${c.after!.acl}" makes objects readable by others` : null),
  },
  {
    name: 'aws-s3-public-access-block-off', severity: 'high',
    check: c => {
      if (!/^aws_s3_(bucket|account)_public_access_block$/.test(c.type)) return null;
      const off = ['block_public_acls', 'block_public_policy', 'ignore_public_acls', 'restrict_public_buckets'].filter(k => known(c, k) && c.after?.[k] === false);
      return off.length ? `public access block has ${off.join(', ')} turned off` : null;
    },
  },
  {
    name: 'aws-s3-public-policy', severity: 'critical',
    check: c => {
      if (c.type !== 'aws_s3_bucket_policy' || !known(c, 'policy')) return null;
      const open = statements(parseJson(c.after?.policy)).some(s => allows(s) && !s.Condition && (s.Principal === '*' || isStar(s.Principal?.AWS)));
      return open ? 'bucket policy allows anyone ("Principal": "*") without a condition' : null;
    },
  },
  {
    name: 'aws-security-group-open-ingress', severity: 'high',
    check: c => {
      const open: string[] = [];
      if (c.type === 'aws_security_group' && known(c, 'ingress')) {
        for (const r of list(c.after?.ingress)) {
          const cidrs = [...list(r?.cidr_blocks), ...list(r?.ipv6_cidr_blocks)];
          if (cidrs.some(x => x === OPEN_V4 || x === OPEN_V6) && !onlyWeb(r.from_port, r.to_port, r.protocol)) open.push(portText(r.from_port, r.to_port, r.protocol));
        }
      }
      if (c.type === 'aws_security_group_rule' && c.after?.type === 'ingress' && known(c, 'cidr_blocks')) {
        const cidrs = [...list(c.after?.cidr_blocks), ...list(c.after?.ipv6_cidr_blocks)];
        if (cidrs.some(x => x === OPEN_V4 || x === OPEN_V6) && !onlyWeb(c.after.from_port, c.after.to_port, c.after.protocol)) open.push(portText(c.after.from_port, c.after.to_port, c.after.protocol));
      }
      if (c.type === 'aws_vpc_security_group_ingress_rule') {
        const a = c.after ?? {};
        if ((a.cidr_ipv4 === OPEN_V4 || a.cidr_ipv6 === OPEN_V6) && !onlyWeb(a.from_port, a.to_port, a.ip_protocol)) open.push(portText(a.from_port, a.to_port, a.ip_protocol));
      }
      return open.length ? `open to the internet on ${[...new Set(open)].join(', ')}` : null;
    },
  },
  {
    name: 'aws-storage-unencrypted', severity: 'high',
    check: c => {
      const flag: Record<string, string> = {
        aws_db_instance: 'storage_encrypted', aws_rds_cluster: 'storage_encrypted', aws_docdb_cluster: 'storage_encrypted',
        aws_neptune_cluster: 'storage_encrypted', aws_ebs_volume: 'encrypted', aws_efs_file_system: 'encrypted',
        aws_elasticache_replication_group: 'at_rest_encryption_enabled', aws_redshift_cluster: 'encrypted',
      };
      const attr = flag[c.type];
      return attr && known(c, attr) && c.after?.[attr] === false ? `stored unencrypted (${attr} = false)` : null;
    },
  },
  {
    name: 'aws-iam-wildcard', severity: 'critical',
    check: c => {
      if (!/^aws_iam_(policy|role_policy|user_policy|group_policy)$/.test(c.type) || !known(c, 'policy')) return null;
      const wild = statements(parseJson(c.after?.policy)).some(s => allows(s) && isStar(s.Action) && isStar(s.Resource));
      return wild ? 'allows every action on every resource ("Action": "*", "Resource": "*")' : null;
    },
  },
  {
    name: 'aws-database-public', severity: 'high',
    check: c => (/^aws_(db_instance|rds_cluster_instance)$/.test(c.type) && known(c, 'publicly_accessible') && c.after?.publicly_accessible === true
      ? 'database is publicly accessible' : null),
  },
  {
    name: 'aws-deletion-protection-off', severity: 'high',
    check: c => {
      const attr = c.type === 'aws_lb' || c.type === 'aws_alb' ? 'enable_deletion_protection' : /^aws_(db_instance|rds_cluster|dynamodb_table|docdb_cluster|neptune_cluster)$/.test(c.type) ? 'deletion_protection' : '';
      if (!attr) return null;
      const attrName = c.type === 'aws_dynamodb_table' ? 'deletion_protection_enabled' : attr;
      return c.before?.[attrName] === true && c.after?.[attrName] === false ? `turns deletion protection off (${attrName})` : null;
    },
  },
  {
    name: 'aws-kms-key-deleted', severity: 'critical',
    check: c => (c.type === 'aws_kms_key' && (c.action === 'delete' || c.action === 'replace') ? 'schedules a KMS key for deletion: data encrypted with it becomes unreadable' : null),
  },
  {
    name: 'aws-kms-rotation-off', severity: 'medium',
    check: c => (c.type === 'aws_kms_key' && c.action !== 'delete' && known(c, 'enable_key_rotation') && c.after?.enable_key_rotation === false
      && (c.after?.customer_master_key_spec ?? 'SYMMETRIC_DEFAULT') === 'SYMMETRIC_DEFAULT' ? 'key rotation is off' : null),
  },
  {
    name: 'aws-audit-or-backup-removed', severity: 'critical',
    check: c => {
      if (/^aws_(cloudtrail|backup_vault|backup_plan|config_configuration_recorder|guardduty_detector)$/.test(c.type) && c.action === 'delete') return `deletes ${c.type.replace(/^aws_/, '').replace(/_/g, ' ')}`;
      if (c.type === 'aws_cloudtrail' && known(c, 'enable_logging') && c.after?.enable_logging === false) return 'turns CloudTrail logging off';
      return null;
    },
  },
  {
    name: 'aws-eks-public-endpoint', severity: 'medium',
    check: c => {
      if (c.type !== 'aws_eks_cluster' || !known(c, 'vpc_config')) return null;
      const v = list(c.after?.vpc_config)[0];
      return v?.endpoint_public_access === true && list(v.public_access_cidrs ?? [OPEN_V4]).includes(OPEN_V4)
        ? 'cluster API is reachable from the whole internet (public_access_cidrs includes 0.0.0.0/0)' : null;
    },
  },
];

export const BUILTIN_RULE_NAMES = RULES.map(r => r.name);
export const BUILTIN_PACKS = ['security'];

export const securityFindings = (plan: Record<string, any>, disabled: string[] = []): Finding[] => {
  const findings: Finding[] = [];
  const rules = RULES.filter(r => !disabled.includes(r.name));
  for (const rc of plan.resource_changes ?? []) {
    if (rc.mode === 'data') continue;
    const action = actionOf(rc.change?.actions ?? []);
    if (!['create', 'update', 'replace', 'delete'].includes(action)) continue;
    const c: Change = {
      address: rc.address, type: rc.type, action,
      before: rc.change?.before ?? null,
      after: action === 'delete' ? null : rc.change?.after ?? null,
      unknown: rc.change?.after_unknown ?? {},
    };
    for (const r of rules) {
      // Deletes are only judged by the rules about deleting.
      if (action === 'delete' && !['aws-kms-key-deleted', 'aws-audit-or-backup-removed'].includes(r.name)) continue;
      const msg = r.check(c);
      if (msg) findings.push({ rule: r.name, severity: r.severity, address: rc.address, message: msg });
    }
  }
  return findings;
};
