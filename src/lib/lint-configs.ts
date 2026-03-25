import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';

// --- Config Templates ---
// Keep shared TS rules in sync between ESLINT_TS and ESLINT_TS_REACT

export const ESLINT_TS = `import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    plugins: {
      import: importPlugin,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'import/no-default-export': 'error',
      'max-lines': ['warn', { max: 200, skipBlankLines: true, skipComments: true }],
      'no-console': ['warn', { allow: ['error', 'warn'] }],
    },
  },
);
`;

export const ESLINT_TS_REACT = `import tseslint from 'typescript-eslint';
import reactPlugin from 'eslint-plugin-react';
import jsxA11yPlugin from 'eslint-plugin-jsx-a11y';
import importPlugin from 'eslint-plugin-import';

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    plugins: {
      react: reactPlugin,
      'jsx-a11y': jsxA11yPlugin,
      import: importPlugin,
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'react/button-has-type': 'error',
      'import/no-default-export': 'error',
      'jsx-a11y/anchor-is-valid': 'warn',
      'jsx-a11y/click-events-have-key-events': 'warn',
      'max-lines': ['warn', { max: 200, skipBlankLines: true, skipComments: true }],
      'no-console': ['warn', { allow: ['error', 'warn'] }],
    },
  },
);
`;

// Backwards compat alias
export const ESLINT_UNIVERSAL = ESLINT_TS_REACT;

export const ESLINT_PERSONAL = `import universalConfig from './eslint.config.js';

export default [
  ...universalConfig,
  {
    rules: {
      'no-warning-comments': ['warn', { terms: ['TODO', 'FIXME', 'HACK'] }],
    },
  },
];
`;

export const STYLELINT_UNIVERSAL = JSON.stringify(
  {
    extends: ['stylelint-config-standard-scss'],
    rules: {
      'unit-disallowed-list': ['vh', 'vw'],
      'declaration-property-unit-allowed-list': {
        padding: ['rem', '%'],
        margin: ['rem', '%'],
        gap: ['rem', '%'],
        'border-width': ['px'],
        'font-size': ['rem'],
      },
      'color-no-hex': [true, { severity: 'warning' }],
      'declaration-no-important': true,
      'declaration-block-no-duplicate-properties': true,
      'shorthand-property-no-redundant-values': [true, { severity: 'warning' }],
    },
  },
  null,
  2,
);

export const STYLELINT_PERSONAL = JSON.stringify(
  {
    extends: ['./.stylelintrc.json'],
    rules: {
      'selector-class-pattern': [
        '^c-[a-z][a-z0-9]*(__[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*)?$',
        {
          message: 'Class names must use BEM with c- prefix (e.g. c-block__element-modifier)',
        },
      ],
      'unit-disallowed-list': ['vh', 'vw', 'dvh'],
      'media-feature-name-disallowed-list': ['max-width'],
      'max-nesting-depth': [3, { severity: 'warning' }],
    },
  },
  null,
  2,
);

// --- Stack Detection ---

export interface ProjectStack {
  hasPackageJson: boolean;
  hasTypeScript: boolean;
  hasReact: boolean;
  hasScss: boolean;
}

function hasScssFiles(dir: string): boolean {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (entry === 'node_modules') continue;

    const fullPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      if (hasScssFiles(fullPath)) return true;
    } else if (entry.endsWith('.scss')) {
      return true;
    }
  }

  return false;
}

export function detectStack(projectDir: string): ProjectStack {
  const packageJsonPath = resolve(projectDir, 'package.json');
  const tsConfigPath = resolve(projectDir, 'tsconfig.json');

  const hasPackageJson = existsSync(packageJsonPath);
  const hasTypeScript = existsSync(tsConfigPath);

  let hasReact = false;
  if (hasPackageJson) {
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      hasReact = 'react' in deps;
    } catch {
      // leave hasReact false
    }
  }

  const hasScss = hasScssFiles(projectDir);

  return { hasPackageJson, hasTypeScript, hasReact, hasScss };
}

// --- Config Set ---

export interface LintConfigSet {
  eslint: { filename: string; content: string } | null;
  stylelint: { filename: string; content: string } | null;
}

export function getConfigsForStack(stack: ProjectStack, personal: boolean): LintConfigSet {
  const needsEslint = stack.hasTypeScript || stack.hasReact;
  const needsStylelint = stack.hasScss;

  const eslint = needsEslint
    ? {
        filename: personal ? 'eslint.config.personal.js' : 'eslint.config.js',
        content: personal ? ESLINT_PERSONAL : (stack.hasReact ? ESLINT_TS_REACT : ESLINT_TS),
      }
    : null;

  const stylelint = needsStylelint
    ? {
        filename: personal ? '.stylelintrc.personal.json' : '.stylelintrc.json',
        content: personal ? STYLELINT_PERSONAL : STYLELINT_UNIVERSAL,
      }
    : null;

  return { eslint, stylelint };
}
