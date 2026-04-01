import { describe, it, expect } from 'vitest';
import { homedir } from 'os';

// Test the path derivation logic without loading config (which needs env vars)
describe('config path resolution', () => {
  it('derives Claude project dir from homedir', () => {
    const home = homedir();
    const projectDir = home.replace(/\//g, '-');
    const memoryDir = `${home}/.claude/projects/${projectDir}/memory`;

    // Should not contain double slashes
    expect(memoryDir).not.toContain('//');

    // Should end with /memory
    expect(memoryDir).toMatch(/\/memory$/);

    // Project dir should start with - (since /home starts with /)
    expect(projectDir).toMatch(/^-/);
  });

  it('handles different home directories', () => {
    // Simulate various home paths
    const testCases = [
      { home: '/home/adrian', expected: '-home-adrian' },
      { home: '/home/sarah', expected: '-home-sarah' },
      { home: '/Users/john', expected: '-Users-john' },
      { home: '/root', expected: '-root' },
    ];

    for (const { home, expected } of testCases) {
      const projectDir = home.replace(/\//g, '-');
      expect(projectDir).toBe(expected);
    }
  });
});
