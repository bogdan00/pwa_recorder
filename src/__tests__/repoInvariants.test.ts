import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../..');
const E2E_DIR = path.join(REPO_ROOT, 'e2e');
const CUJ_DIR = path.join(REPO_ROOT, 'cuj');
const ADR_DIR = path.join(REPO_ROOT, 'adr');

describe('Repository E2E, CUJ & ADR systemic invariants', () => {
  const e2eFiles = fs
    .readdirSync(E2E_DIR)
    .filter((f) => f.endsWith('.ts'))
    .sort();
  const cujSpecFiles = e2eFiles.filter((f) => f.startsWith('cuj-') && f.endsWith('.spec.ts'));

  it('requires every CUJ E2E spec to import test/expect from ./fixtures (enforcing network fence, pageerror guard, and CPU throttling)', () => {
    expect(cujSpecFiles.length).toBeGreaterThan(0);

    for (const file of cujSpecFiles) {
      const src = fs.readFileSync(path.join(E2E_DIR, file), 'utf8');
      expect(
        src,
        `${file} must import { test, expect } from './fixtures' instead of '@playwright/test'`,
      ).toMatch(/from\s+['"]\.\/fixtures['"]/);
      expect(
        src,
        `${file} must not import test/expect directly from '@playwright/test'`,
      ).not.toMatch(/from\s+['"]@playwright\/test['"]/);
    }
  });

  it('forbids fixed sleeps (waitForTimeout / setTimeout) across all e2e/ files', () => {
    for (const file of e2eFiles) {
      const src = fs.readFileSync(path.join(E2E_DIR, file), 'utf8');
      expect(src, `${file} must not call waitForTimeout(...)`).not.toMatch(
        /\bwaitForTimeout\s*\(/,
      );
      expect(src, `${file} must not call setTimeout(...)`).not.toMatch(
        /\bsetTimeout\s*\(/,
      );
    }
  });

  it('maintains 1-to-1 mapping between cuj/CUJ-*.md docs, cuj/README.md, and e2e/cuj-*.spec.ts', () => {
    const readme = fs.readFileSync(path.join(CUJ_DIR, 'README.md'), 'utf8');
    const cujDocs = fs
      .readdirSync(CUJ_DIR)
      .filter((f) => /^CUJ-\d+-.*\.md$/.test(f))
      .sort();

    expect(cujDocs.length).toBe(cujSpecFiles.length);

    for (const doc of cujDocs) {
      const expectedSpec = `${doc.replace(/\.md$/, '').toLowerCase()}.spec.ts`;
      expect(
        cujSpecFiles,
        `Missing matching E2E spec ${expectedSpec} for ${doc}`,
      ).toContain(expectedSpec);
      expect(
        readme,
        `${doc} must be registered in cuj/README.md`,
      ).toContain(doc);
    }
  });

  it('registers every adr/ADR-*.md document in adr/README.md and keeps CUJ <-> ADR cross-links valid', () => {
    const adrReadme = fs.readFileSync(path.join(ADR_DIR, 'README.md'), 'utf8');
    const adrDocs = fs
      .readdirSync(ADR_DIR)
      .filter((f) => /^ADR-\d+-.*\.md$/.test(f))
      .sort();

    expect(adrDocs.length).toBeGreaterThan(0);

    for (const doc of adrDocs) {
      expect(
        adrReadme,
        `${doc} must be registered in adr/README.md`,
      ).toContain(doc);
    }

    // Verify all relative markdown links inside cuj/*.md and adr/*.md resolve to real files
    const mdDirs = [CUJ_DIR, ADR_DIR];
    const linkPattern = /\]\((\.\.?\/[^)#\s]+)\)/g;
    for (const dir of mdDirs) {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
      for (const file of files) {
        const fullPath = path.join(dir, file);
        const content = fs.readFileSync(fullPath, 'utf8');
        let match: RegExpExecArray | null;
        while ((match = linkPattern.exec(content)) !== null) {
          const targetRel = match[1];
          const resolved = path.resolve(dir, targetRel);
          expect(
            fs.existsSync(resolved),
            `Broken relative link (${targetRel}) in ${path.relative(REPO_ROOT, fullPath)}`,
          ).toBe(true);
        }
      }
    }
  });
});
