import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { resolve } from 'path';
import {
  detectStack,
  getConfigsForStack,
  ESLINT_UNIVERSAL,
  ESLINT_TS,
  ESLINT_TS_REACT,
  ESLINT_PERSONAL,
  STYLELINT_UNIVERSAL,
  STYLELINT_PERSONAL,
} from '../src/lib/lint-configs.js';

const TEST_DIR = '/tmp/ledger-lint-test';

describe('detectStack', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('detects empty directory', () => {
    const stack = detectStack(TEST_DIR);
    expect(stack.hasPackageJson).toBe(false);
    expect(stack.hasTypeScript).toBe(false);
    expect(stack.hasReact).toBe(false);
    expect(stack.hasScss).toBe(false);
  });

  it('detects TypeScript project', () => {
    writeFileSync(resolve(TEST_DIR, 'package.json'), JSON.stringify({ dependencies: {} }));
    writeFileSync(resolve(TEST_DIR, 'tsconfig.json'), '{}');
    const stack = detectStack(TEST_DIR);
    expect(stack.hasTypeScript).toBe(true);
    expect(stack.hasReact).toBe(false);
  });

  it('detects React project', () => {
    writeFileSync(resolve(TEST_DIR, 'package.json'), JSON.stringify({ dependencies: { react: '^18' } }));
    const stack = detectStack(TEST_DIR);
    expect(stack.hasReact).toBe(true);
  });

  it('detects SCSS project', () => {
    writeFileSync(resolve(TEST_DIR, 'package.json'), '{}');
    mkdirSync(resolve(TEST_DIR, 'src'), { recursive: true });
    writeFileSync(resolve(TEST_DIR, 'src/styles.scss'), '.test {}');
    const stack = detectStack(TEST_DIR);
    expect(stack.hasScss).toBe(true);
  });
});

describe('getConfigsForStack', () => {
  it('returns ESLint for TypeScript project', () => {
    const configs = getConfigsForStack(
      { hasPackageJson: true, hasTypeScript: true, hasReact: false, hasScss: false },
      false,
    );
    expect(configs.eslint).not.toBeNull();
    expect(configs.eslint!.filename).toBe('eslint.config.js');
    expect(configs.stylelint).toBeNull();
  });

  it('returns both for React + SCSS project', () => {
    const configs = getConfigsForStack(
      { hasPackageJson: true, hasTypeScript: true, hasReact: true, hasScss: true },
      false,
    );
    expect(configs.eslint).not.toBeNull();
    expect(configs.stylelint).not.toBeNull();
  });

  it('returns personal filenames when personal flag set', () => {
    const configs = getConfigsForStack(
      { hasPackageJson: true, hasTypeScript: true, hasReact: true, hasScss: true },
      true,
    );
    expect(configs.eslint!.filename).toBe('eslint.config.personal.js');
    expect(configs.stylelint!.filename).toBe('.stylelintrc.personal.json');
  });

  it('returns nothing for plain JS project (no TS, no React, no SCSS)', () => {
    const configs = getConfigsForStack(
      { hasPackageJson: true, hasTypeScript: false, hasReact: false, hasScss: false },
      false,
    );
    expect(configs.eslint).toBeNull();
    expect(configs.stylelint).toBeNull();
  });

  it('personal ESLint imports universal', () => {
    const configs = getConfigsForStack(
      { hasPackageJson: true, hasTypeScript: true, hasReact: false, hasScss: false },
      true,
    );
    expect(configs.eslint!.content).toContain("from './eslint.config.js'");
  });

  it('personal Stylelint extends universal', () => {
    const configs = getConfigsForStack(
      { hasPackageJson: true, hasTypeScript: false, hasReact: false, hasScss: true },
      true,
    );
    const parsed = JSON.parse(configs.stylelint!.content);
    expect(parsed.extends).toContain('./.stylelintrc.json');
  });

  it('returns TS-only ESLint for TypeScript project without React', () => {
    const configs = getConfigsForStack(
      { hasPackageJson: true, hasTypeScript: true, hasReact: false, hasScss: false },
      false,
    );
    expect(configs.eslint).not.toBeNull();
    expect(configs.eslint!.content).toContain('no-explicit-any');
    expect(configs.eslint!.content).not.toContain('eslint-plugin-react');
    expect(configs.eslint!.content).not.toContain('jsx-a11y');
    expect(configs.eslint!.content).not.toContain('button-has-type');
  });

  it('returns TS+React ESLint for React project', () => {
    const configs = getConfigsForStack(
      { hasPackageJson: true, hasTypeScript: true, hasReact: true, hasScss: false },
      false,
    );
    expect(configs.eslint).not.toBeNull();
    expect(configs.eslint!.content).toContain('eslint-plugin-react');
    expect(configs.eslint!.content).toContain('jsx-a11y');
    expect(configs.eslint!.content).toContain('button-has-type');
  });
});

describe('lint config content', () => {
  it('ESLint universal contains all required rules', () => {
    expect(ESLINT_UNIVERSAL).toContain('no-explicit-any');
    expect(ESLINT_UNIVERSAL).toContain('consistent-type-definitions');
    expect(ESLINT_UNIVERSAL).toContain('button-has-type');
    expect(ESLINT_UNIVERSAL).toContain('no-default-export');
    expect(ESLINT_UNIVERSAL).toContain('anchor-is-valid');
    expect(ESLINT_UNIVERSAL).toContain('max-lines');
    expect(ESLINT_UNIVERSAL).toContain('no-console');
  });

  it('ESLint TS-only does NOT contain React rules', () => {
    expect(ESLINT_TS).toContain('no-explicit-any');
    expect(ESLINT_TS).toContain('consistent-type-definitions');
    expect(ESLINT_TS).toContain('no-default-export');
    expect(ESLINT_TS).not.toContain('react');
    expect(ESLINT_TS).not.toContain('jsx-a11y');
  });

  it('ESLint TS+React contains both TS and React rules', () => {
    expect(ESLINT_TS_REACT).toContain('no-explicit-any');
    expect(ESLINT_TS_REACT).toContain('button-has-type');
    expect(ESLINT_TS_REACT).toContain('jsx-a11y');
  });

  it('ESLint personal extends universal', () => {
    expect(ESLINT_PERSONAL).toContain("from './eslint.config.js'");
    expect(ESLINT_PERSONAL).toContain('no-warning-comments');
  });

  it('Stylelint universal has correct disallowed units', () => {
    const parsed = JSON.parse(STYLELINT_UNIVERSAL);
    expect(parsed.rules['unit-disallowed-list']).toEqual(['vh', 'vw']);
  });

  it('Stylelint personal adds dvh and max-width ban', () => {
    const parsed = JSON.parse(STYLELINT_PERSONAL);
    expect(parsed.rules['unit-disallowed-list']).toEqual(['vh', 'vw', 'dvh']);
    expect(parsed.rules['media-feature-name-disallowed-list']).toEqual(['max-width']);
  });

  it('Stylelint personal has BEM c- pattern', () => {
    const parsed = JSON.parse(STYLELINT_PERSONAL);
    const pattern = parsed.rules['selector-class-pattern'][0];
    const regex = new RegExp(pattern);
    expect(regex.test('c-card')).toBe(true);
    expect(regex.test('c-card__title')).toBe(true);
    expect(regex.test('c-card__header-title')).toBe(true);
    expect(regex.test('card')).toBe(false);
    expect(regex.test('c-card--primary')).toBe(false);
  });
});
