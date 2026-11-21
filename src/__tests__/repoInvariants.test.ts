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

  it('keeps every color theme isolated in its own src/styles/themes/<id>.css file imported by tokens.css', () => {
    const themesDir = path.join(REPO_ROOT, 'src/styles/themes');
    const tokensCss = fs.readFileSync(
      path.join(REPO_ROOT, 'src/styles/tokens.css'),
      'utf8',
    );
    const themesTs = fs.readFileSync(
      path.join(REPO_ROOT, 'src/styles/themes.ts'),
      'utf8',
    );

    const themeCssFiles = fs
      .readdirSync(themesDir)
      .filter((f) => f.endsWith('.css'))
      .sort();

    // Extract every concrete id: '...' entry from THEME_DEFINITIONS
    const registeredIds = Array.from(
      themesTs.matchAll(/\bid:\s*'([a-z0-9-]+)'/g),
      (m) => m[1],
    ).sort();

    expect(registeredIds.length).toBe(10);
    expect(themeCssFiles).toEqual(registeredIds.map((id) => `${id}.css`));

    for (const id of registeredIds) {
      expect(
        tokensCss,
        `src/styles/tokens.css must @import './themes/${id}.css'`,
      ).toContain(`@import './themes/${id}.css';`);

      const cssContent = fs.readFileSync(path.join(themesDir, `${id}.css`), 'utf8');
      expect(
        cssContent,
        `src/styles/themes/${id}.css must scope its tokens under [data-theme='${id}']`,
      ).toContain(`[data-theme='${id}']`);
    }
  });

  it('forbids mobile horizontal-overflow CSS footguns (bare 1fr 1fr grids and overflow-x: hidden on html/body)', () => {
    const collectCssFiles = (dir: string): string[] => {
      const results: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...collectCssFiles(full));
        } else if (entry.isFile() && entry.name.endsWith('.css')) {
          results.push(full);
        }
      }
      return results;
    };

    const cssFiles = collectCssFiles(path.join(REPO_ROOT, 'src'));
    expect(cssFiles.length).toBeGreaterThan(0);

    for (const file of cssFiles) {
      const rel = path.relative(REPO_ROOT, file);
      const css = fs.readFileSync(file, 'utf8');

      // Bare `1fr 1fr` defaults to minmax(auto, 1fr), allowing wide children to push past 360px phones
      expect(
        css,
        `${rel}: use repeat(N, minmax(0, 1fr)) instead of bare repeated 1fr tracks so mobile viewports never overflow`,
      ).not.toMatch(/grid-template-columns\s*:\s*[^;]*\b1fr\s+1fr\b/);
    }

    const globalCss = fs.readFileSync(
      path.join(REPO_ROOT, 'src/styles/global.css'),
      'utf8',
    );
    expect(
      globalCss,
      'src/styles/global.css must use overflow-x: clip (not overflow-x: hidden) so position: sticky headers keep working',
    ).not.toMatch(/overflow-x\s*:\s*hidden/);
  });

  it('enforces ADR-11 two-tier formal verification parity across precheck, CI, and formal specs', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    const deployYml = fs.readFileSync(
      path.join(REPO_ROOT, '.github/workflows/deploy.yml'),
      'utf8',
    );
    const viteCfg = fs.readFileSync(
      path.join(REPO_ROOT, 'vite.config.ts'),
      'utf8',
    );

    expect(pkg.scripts?.['test:formal']).toContain('vitest.formal.config.ts');
    expect(pkg.scripts?.precheck).toContain('npm run test:formal');
    expect(deployYml).toContain('npm run test:formal');
    expect(viteCfg).toContain('**/*.formal.test.ts');

    const formalSpecsDir = path.join(REPO_ROOT, 'src/formal/specs');
    const formalTestsDir = path.join(REPO_ROOT, 'src/formal/__tests__');
    const specs = fs.readdirSync(formalSpecsDir).filter((f) => f.endsWith('Spec.ts'));
    const tests = fs.readdirSync(formalTestsDir).filter((f) => f.endsWith('.test.ts'));
    const z3Tests = tests.filter((f) => f.endsWith('.formal.test.ts'));

    expect(specs.length).toBeGreaterThanOrEqual(4);
    expect(z3Tests.length).toBeGreaterThanOrEqual(3);

    // Every declarative spec in src/formal/specs/<name>Spec.ts must have at least one Tier 1 test file
    for (const spec of specs) {
      const baseName = spec.replace(/Spec\.ts$/, '');
      const hasTier1 = tests.some(
        (t) => t.startsWith(baseName) && !t.endsWith('.formal.test.ts'),
      );
      expect(
        hasTier1,
        `Missing Tier 1 formal verification test for src/formal/specs/${spec}`,
      ).toBe(true);
    }
  });
});
