const fs = require('fs');
const {spawn} = require('child_process');
const {P_END, P_OK, P_ERROR, P_WARN, P_INFO} = require('../utils/colors');

/**
 * Removes comments from Terraform content
 * Handles: # comments, // comments, and block comments
 */
const removeComments = (content) => {
  // Remove block comments /* */
  content = content.replace(/\/\*[\s\S]*?\*\//g, '');

  // Remove single line comments (# and //)
  const lines = content.split('\n');
  const cleanedLines = lines.map(line => {
    // Find position of # or // that's not inside a string
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

    if (commentStart !== -1) {
      return line.substring(0, commentStart);
    }
    return line;
  });

  return cleanedLines.join('\n');
};

/**
 * Extracts terraform targets from file content
 * Returns array of target strings like "aws_instance.example", "module.vpc", etc.
 */
const extractTargets = (content) => {
  const targets = [];

  // Remove comments first
  const cleanContent = removeComments(content);

  // Pattern for resource blocks: resource "type" "name"
  const resourcePattern = /resource\s+"([^"]+)"\s+"([^"]+)"/g;
  let match;
  while ((match = resourcePattern.exec(cleanContent)) !== null) {
    targets.push(`${match[1]}.${match[2]}`);
  }

  // Pattern for data blocks: data "type" "name"
  const dataPattern = /data\s+"([^"]+)"\s+"([^"]+)"/g;
  while ((match = dataPattern.exec(cleanContent)) !== null) {
    targets.push(`data.${match[1]}.${match[2]}`);
  }

  // Pattern for module blocks: module "name"
  const modulePattern = /module\s+"([^"]+)"/g;
  while ((match = modulePattern.exec(cleanContent)) !== null) {
    targets.push(`module.${match[1]}`);
  }

  return targets;
};

/**
 * Extracts targets from one or more terraform files
 */
const extractTargetsFromFiles = (files) => {
  const allTargets = [];
  const fileList = Array.isArray(files) ? files : [files];

  fileList.forEach(filename => {
    if (!fs.existsSync(filename)) {
      console.log(`${P_WARN}Warning: File '${filename}' not found, skipping${P_END}`);
      return;
    }

    const content = fs.readFileSync(filename, 'utf8');
    const targets = extractTargets(content);

    if (targets.length > 0) {
      console.log(`${P_INFO}Found ${targets.length} target(s) in '${filename}':${P_END}`);
      targets.forEach(target => {
        console.log(`  - ${target}`);
        if (!allTargets.includes(target)) {
          allTargets.push(target);
        }
      });
    } else {
      console.log(`${P_WARN}No targets found in '${filename}'${P_END}`);
    }
  });

  return allTargets;
};

/**
 * Runs a terraform command (plan, apply, destroy) with optional file-based targets
 * @param {string} command - The terraform command (plan, apply, destroy)
 * @param {string|string[]} files - Optional file(s) to extract targets from
 * @param {string[]} extraArgs - Additional arguments to pass to terraform
 */
exports.runTerraformCommand = async (command, files, extraArgs = []) => {
  try {
    const args = [command];

    // Extract targets from files if provided
    if (files && (Array.isArray(files) ? files.length > 0 : true)) {
      console.log(`${P_OK}Extracting targets from file(s)...${P_END}\n`);
      const targets = extractTargetsFromFiles(files);

      if (targets.length > 0) {
        console.log(`\n${P_OK}Total unique targets: ${targets.length}${P_END}\n`);
        targets.forEach(target => {
          args.push('-target', target);
        });
      } else {
        console.log(`${P_WARN}No targets extracted from files. Running without file-based targets.${P_END}\n`);
      }
    }

    // Add any extra arguments passed through
    if (extraArgs && extraArgs.length > 0) {
      args.push(...extraArgs);
    }

    console.log(`${P_OK}Running: terraform ${args.join(' ')}${P_END}\n`);

    // Execute terraform command
    const tf = spawn('terraform', args, {
      stdio: 'inherit',
      cwd: process.cwd()
    });

    tf.on('error', (err) => {
      console.log(`${P_ERROR}Error executing terraform: ${err.message}${P_END}`);
      process.exit(1);
    });

    tf.on('close', (code) => {
      process.exit(code);
    });

  } catch (err) {
    console.log(`${P_ERROR}Error: ${err.message}${P_END}`);
    process.exit(1);
  }
};
