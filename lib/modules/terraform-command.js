const fs = require('fs');
const { spawn } = require('child_process');
const { normalizeProvider, getCliName, getBinTarget } = require('../utils/paths');
const { P_END, P_OK, P_ERROR, P_WARN, P_INFO } = require('../utils/colors');

/**
 * Removes comments from Terraform content.
 * Handles: # comments, // comments, and block comments.
 */
const removeComments = (content) => {
  content = content.replace(/\/\*[\s\S]*?\*\//g, '');

  const lines = content.split('\n');
  const cleanedLines = lines.map(line => {
    let inString = false;
    let stringChar = '';
    let commentStart = -1;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const nextChar = line[i + 1];

      if (!inString && (char === '"' || char === "'")) {
        inString = true;
        stringChar = char;
      } else if (inString && char === stringChar && line[i - 1] !== '\\') {
        inString = false;
      } else if (!inString) {
        if (char === '#' || (char === '/' && nextChar === '/')) {
          commentStart = i;
          break;
        }
      }
    }

    return commentStart !== -1 ? line.substring(0, commentStart) : line;
  });

  return cleanedLines.join('\n');
};

/**
 * Extracts terraform targets from file content.
 */
const extractTargets = (content) => {
  const targets = [];
  const clean = removeComments(content);

  const resourcePattern = /resource\s+"([^"]+)"\s+"([^"]+)"/g;
  const dataPattern = /data\s+"([^"]+)"\s+"([^"]+)"/g;
  const modulePattern = /module\s+"([^"]+)"/g;

  let match;
  while ((match = resourcePattern.exec(clean)) !== null) targets.push(`${match[1]}.${match[2]}`);
  while ((match = dataPattern.exec(clean)) !== null) targets.push(`data.${match[1]}.${match[2]}`);
  while ((match = modulePattern.exec(clean)) !== null) targets.push(`module.${match[1]}`);

  return targets;
};

const extractTargetsFromFiles = (files) => {
  const allTargets = [];
  const fileList = Array.isArray(files) ? files : [files];

  fileList.forEach(filename => {
    if (!fs.existsSync(filename)) {
      console.log(`${P_WARN}Warning: '${filename}' not found, skipping${P_END}`);
      return;
    }

    const targets = extractTargets(fs.readFileSync(filename, 'utf8'));
    if (targets.length > 0) {
      console.log(`${P_INFO}Found ${targets.length} target(s) in '${filename}':${P_END}`);
      targets.forEach(t => {
        console.log(`  - ${t}`);
        if (!allTargets.includes(t)) allTargets.push(t);
      });
    } else {
      console.log(`${P_WARN}No targets found in '${filename}'${P_END}`);
    }
  });

  return allTargets;
};

/**
 * Runs a terraform/tofu command with optional file-based targets.
 * Uses the active tfv-managed binary from ~/.tfv/bin so that `tfv plan`
 * and a bare `terraform plan` always use the exact same binary.
 *
 * @param {string} command   - terraform subcommand (plan, apply, destroy, init, fmt, validate…)
 * @param {string|string[]} files  - optional file(s) to extract -target args from
 * @param {string[]} extraArgs     - additional flags passed after --
 * @param {string} providerArg     - 'terraform' (default) or 'tofu'/'opentofu'
 */
exports.runTerraformCommand = async (command, files, extraArgs = [], providerArg = 'terraform') => {
  try {
    const provider = normalizeProvider(providerArg);
    const cli = getCliName(provider);

    // Resolve the exact binary tfv manages; fall back to PATH-resolved cli name
    // This guarantees tfv commands and bare `terraform`/`tofu` point to the same binary.
    const binaryPath = getBinTarget(provider);
    const binary = fs.existsSync(binaryPath) ? binaryPath : cli;

    const args = [command];

    if (files && (Array.isArray(files) ? files.length > 0 : true)) {
      console.log(`${P_OK}Extracting targets from file(s)...${P_END}\n`);
      const targets = extractTargetsFromFiles(files);

      if (targets.length > 0) {
        console.log(`\n${P_OK}Total unique targets: ${targets.length}${P_END}\n`);
        targets.forEach(t => args.push('-target', t));
      } else {
        console.log(`${P_WARN}No targets extracted. Running without file-based targets.${P_END}\n`);
      }
    }

    if (extraArgs && extraArgs.length > 0) args.push(...extraArgs);

    console.log(`${P_OK}Running: ${cli} ${args.join(' ')}${P_END}\n`);

    const tf = spawn(binary, args, { stdio: 'inherit', cwd: process.cwd() });

    tf.on('error', (err) => {
      console.log(`${P_ERROR}Error executing ${cli}: ${err.message}${P_END}`);
      if (err.code === 'ENOENT') {
        console.log(`${P_WARN}${cli} not found. Run: tfv install latest${providerArg === 'terraform' ? '' : ` --provider ${providerArg}`}${P_END}`);
      }
      process.exit(1);
    });

    tf.on('close', code => process.exit(code));

  } catch (err) {
    console.log(`${P_ERROR}Error: ${err.message}${P_END}`);
    process.exit(1);
  }
};

// Export helpers for testing
exports.removeComments = removeComments;
exports.extractTargets = extractTargets;
