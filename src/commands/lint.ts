import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';
import { createInterface } from 'readline';
import {
  detectStack,
  getConfigsForStack,
  ESLINT_TS,
  ESLINT_TS_REACT,
  STYLELINT_UNIVERSAL,
  type ProjectStack,
  type LintConfigSet,
} from '../lib/lint-configs.js';

// --- Helpers ---

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim() === 'y' || answer.trim() === 'yes');
    });
  });
}

// --- writeConfig ---

export async function writeConfig(
  projectDir: string,
  config: { filename: string; content: string },
): Promise<void> {
  const filePath = resolve(projectDir, config.filename);

  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf-8');
    if (existing === config.content) {
      console.error(`  ${config.filename} — already up to date`);
      return;
    }
    const overwrite = await confirm(`  ${config.filename} already exists. Overwrite?`);
    if (!overwrite) {
      console.error(`  ${config.filename} — skipped`);
      return;
    }
  }

  writeFileSync(filePath, config.content, 'utf-8');
  console.error(`  ${config.filename} — written`);
}

// --- handleDiff ---

interface UniversalConfig {
  filename: string;
  content: string;
}

function getUniversalConfigs(hasReact: boolean): { eslint: UniversalConfig; stylelint: UniversalConfig } {
  return {
    eslint: { filename: 'eslint.config.js', content: hasReact ? ESLINT_TS_REACT : ESLINT_TS },
    stylelint: { filename: '.stylelintrc.json', content: STYLELINT_UNIVERSAL },
  };
}

export async function handleDiff(
  projectDir: string,
  configs: LintConfigSet,
  universalConfigs: ReturnType<typeof getUniversalConfigs>,
): Promise<void> {
  const toCheck: Array<{ filename: string; template: string }> = [];

  if (configs.eslint) {
    toCheck.push({ filename: configs.eslint.filename, template: configs.eslint.content });
    // Also check universal if writing personal
    if (configs.eslint.filename !== universalConfigs.eslint.filename) {
      toCheck.push({ filename: universalConfigs.eslint.filename, template: universalConfigs.eslint.content });
    }
  }
  if (configs.stylelint) {
    toCheck.push({ filename: configs.stylelint.filename, template: configs.stylelint.content });
    if (configs.stylelint.filename !== universalConfigs.stylelint.filename) {
      toCheck.push({ filename: universalConfigs.stylelint.filename, template: universalConfigs.stylelint.content });
    }
  }

  if (toCheck.length === 0) {
    console.error('No lint configs applicable for this project stack.');
    return;
  }

  let anyDiff = false;

  for (const { filename, template } of toCheck) {
    const filePath = resolve(projectDir, filename);
    if (!existsSync(filePath)) {
      console.error(`  ${filename} — not found (run without --diff to create)`);
      anyDiff = true;
      continue;
    }
    const existing = readFileSync(filePath, 'utf-8');
    if (existing === template) {
      console.error(`  ${filename} — up to date`);
    } else {
      console.error(`  ${filename} — differs from Ledger template`);
      anyDiff = true;
      const update = await confirm(`  Update ${filename} to Ledger version?`);
      if (update) {
        writeFileSync(filePath, template, 'utf-8');
        console.error(`  ${filename} — updated`);
      }
    }
  }

  if (!anyDiff) {
    console.error('\nAll configs are up to date.');
  }
}

// --- checkDependencies ---

const ESLINT_TS_DEPS = ['typescript-eslint', 'eslint-plugin-import'];
const ESLINT_REACT_DEPS = ['eslint-plugin-react', 'eslint-plugin-jsx-a11y'];
const STYLELINT_DEPS = ['stylelint', 'stylelint-config-standard-scss'];

export async function checkDependencies(
  projectDir: string,
  stack: ProjectStack,
  personal: boolean,
): Promise<void> {
  const packageJsonPath = resolve(projectDir, 'package.json');
  if (!existsSync(packageJsonPath)) return;

  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as typeof pkg;
  } catch {
    return;
  }

  const installed = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);

  const needed: string[] = [];

  const needsEslint = stack.hasTypeScript || stack.hasReact;
  const needsStylelint = stack.hasScss;

  if (needsEslint) {
    for (const dep of ESLINT_TS_DEPS) {
      if (!installed.has(dep)) needed.push(dep);
    }
    if (stack.hasReact) {
      for (const dep of ESLINT_REACT_DEPS) {
        if (!installed.has(dep)) needed.push(dep);
      }
    }
  }
  if (needsStylelint) {
    for (const dep of STYLELINT_DEPS) {
      if (!installed.has(dep)) needed.push(dep);
    }
  }

  if (personal) {
    // no extra deps for personal configs
  }

  if (needed.length === 0) return;

  console.error('\nMissing devDependencies:');
  for (const dep of needed) {
    console.error(`  - ${dep}`);
  }

  const install = await confirm('\nInstall missing dependencies now?');
  if (install) {
    execSync(`npm install --save-dev ${needed.join(' ')}`, { stdio: 'inherit', cwd: projectDir });
  }
}

// --- Main lint command ---

export async function lint(options: { personal: boolean; diff: boolean }): Promise<void> {
  const projectDir = process.cwd();

  console.error('Detecting project stack...');
  const stack = detectStack(projectDir);

  console.error(`  package.json: ${stack.hasPackageJson}`);
  console.error(`  TypeScript:   ${stack.hasTypeScript}`);
  console.error(`  React:        ${stack.hasReact}`);
  console.error(`  SCSS:         ${stack.hasScss}`);
  console.error('');

  const configs = getConfigsForStack(stack, options.personal);
  const universalConfigs = getUniversalConfigs(stack.hasReact);

  if (!configs.eslint && !configs.stylelint) {
    console.error('No lint configs applicable for this stack (needs TypeScript, React, or SCSS).');
    return;
  }

  if (options.diff) {
    console.error('Comparing local configs against Ledger templates...\n');
    await handleDiff(projectDir, configs, universalConfigs);
    return;
  }

  console.error('Writing lint configs...\n');

  // When personal, also write the universal configs that personal ones extend
  if (options.personal) {
    if (configs.eslint) {
      await writeConfig(projectDir, universalConfigs.eslint);
    }
    if (configs.stylelint) {
      await writeConfig(projectDir, universalConfigs.stylelint);
    }
  }

  if (configs.eslint) {
    await writeConfig(projectDir, configs.eslint);
  }
  if (configs.stylelint) {
    await writeConfig(projectDir, configs.stylelint);
  }

  console.error('');
  await checkDependencies(projectDir, stack, options.personal);

  console.error('\nDone.');
}
