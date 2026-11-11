# Release signing keys

teriac checks the signature on each release's checksum file with these keys before it
trusts the checksum, so a mirror or download that was tampered with is refused.

| File | Signs | Primary key fingerprint | Source |
|---|---|---|---|
| `hashicorp.asc` | Terraform | `C874 011F 0AB4 0511 0D02 1055 3436 5D94 72D7 468F` | https://www.hashicorp.com/.well-known/pgp-key.txt |
| `opentofu.asc` | OpenTofu | `E3E6 E43D 84CB 852E ADB0 051D 0C0A F313 E5FD 9F80` | https://get.opentofu.org/opentofu.asc |
| `terragrunt.asc` | Terragrunt (releases from early 2026 on) | `68C8 0F86 DF98 E710 C0F2 2E2E 5777 74AC A847 CC49` | `terragrunt-signing-key.asc` on Terragrunt's GitHub releases |

When a vendor rotates its key, replace the file and update this table.
