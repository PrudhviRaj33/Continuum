import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

const TEST_DB_PATH = path.join(os.tmpdir(), `continuum-html-css-test-${crypto.randomUUID()}.db`);
process.env.DB_PATH = TEST_DB_PATH;
process.env.LOG_LEVEL = 'error';

import { IncrementalParser } from '../src/parser/IncrementalParser';
import { getDb, closeDb } from '../src/database/Database';

const parser = new IncrementalParser();
let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'continuum-html-css-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

afterAll(() => {
  closeDb();
  try { require('fs').unlinkSync(TEST_DB_PATH); } catch { /* ignore */ }
});

async function parseContent(filename: string, content: string) {
  const filePath = path.join(tempDir, filename);
  await fs.writeFile(filePath, content, 'utf-8');
  await parser.parseFile(filePath);

  const db = getDb();
  const file = db.prepare('SELECT id FROM files WHERE path = ?').get(filePath) as { id: number } | undefined;
  if (!file) return [];

  return db
    .prepare('SELECT name, kind FROM symbols WHERE file_id = ? ORDER BY start_line')
    .all(file.id) as { name: string; kind: string }[];
}

// ── HTML / Angular Templates ──────────────────────────────────────────────────

describe('HTML — Angular component selectors', () => {
  it('extracts a custom component tag', async () => {
    const symbols = await parseContent('app.component.html', `
<div class="layout">
  <app-header [title]="pageTitle"></app-header>
  <app-sidebar></app-sidebar>
</div>
`);
    expect(symbols.some((s) => s.name === 'app-header' && s.kind === 'class')).toBe(true);
    expect(symbols.some((s) => s.name === 'app-sidebar' && s.kind === 'class')).toBe(true);
  });

  it('extracts Angular Material components', async () => {
    const symbols = await parseContent('dialog.html', `
<mat-dialog-container>
  <mat-card>
    <mat-button>Submit</mat-button>
  </mat-card>
</mat-dialog-container>
`);
    expect(symbols.some((s) => s.name === 'mat-dialog-container')).toBe(true);
    expect(symbols.some((s) => s.name === 'mat-card')).toBe(true);
    expect(symbols.some((s) => s.name === 'mat-button')).toBe(true);
  });

  it('extracts router-outlet and ng-template built-ins', async () => {
    const symbols = await parseContent('routing.html', `
<router-outlet></router-outlet>
<ng-container *ngIf="isLoggedIn">
  <app-dashboard></app-dashboard>
</ng-container>
`);
    expect(symbols.some((s) => s.name === 'router-outlet')).toBe(true);
    expect(symbols.some((s) => s.name === 'ng-container')).toBe(true);
  });

  it('does NOT extract plain HTML elements (no hyphen)', async () => {
    const symbols = await parseContent('plain.html', `
<div class="wrapper">
  <section>
    <button type="submit">Submit</button>
  </section>
</div>
`);
    const names = symbols.map((s) => s.name);
    expect(names).not.toContain('div');
    expect(names).not.toContain('section');
    expect(names).not.toContain('button');
  });

  it('extracts template reference variables on attribute lines', async () => {
    const symbols = await parseContent('form.html', `
<form #loginForm="ngForm" (ngSubmit)="onSubmit()">
  <input #emailInput type="email" />
</form>
`);
    expect(symbols.some((s) => s.name === 'loginForm' && s.kind === 'property')).toBe(true);
    expect(symbols.some((s) => s.name === 'emailInput' && s.kind === 'property')).toBe(true);
  });

  it('skips HTML comment lines', async () => {
    const symbols = await parseContent('comments.html', `
<!-- This is a comment with <app-fake> inside -->
<app-real></app-real>
`);
    const names = symbols.map((s) => s.name);
    expect(names).not.toContain('app-fake');
    expect(names).toContain('app-real');
  });
});

// ── CSS ───────────────────────────────────────────────────────────────────────

describe('CSS — class selectors', () => {
  it('extracts simple class selectors', async () => {
    const symbols = await parseContent('styles.css', `
.primary-button {
  background: #007bff;
}

.card {
  border-radius: 8px;
}
`);
    expect(symbols.some((s) => s.name === 'primary-button' && s.kind === 'class')).toBe(true);
    expect(symbols.some((s) => s.name === 'card' && s.kind === 'class')).toBe(true);
  });

  it('extracts pseudo-class selectors (.card:hover)', async () => {
    const symbols = await parseContent('hover.css', `
.btn:hover {
  opacity: 0.9;
}
.link:focus {
  outline: 2px solid blue;
}
`);
    expect(symbols.some((s) => s.name === 'btn')).toBe(true);
    expect(symbols.some((s) => s.name === 'link')).toBe(true);
  });

  it('extracts CSS custom properties (design tokens)', async () => {
    const symbols = await parseContent('tokens.css', `
:root {
  --color-primary: #007bff;
  --spacing-sm: 0.5rem;
  --font-size-base: 16px;
}
`);
    expect(symbols.some((s) => s.name === 'color-primary' && s.kind === 'property')).toBe(true);
    expect(symbols.some((s) => s.name === 'spacing-sm' && s.kind === 'property')).toBe(true);
    expect(symbols.some((s) => s.name === 'font-size-base' && s.kind === 'property')).toBe(true);
  });

  it('extracts @keyframes animations', async () => {
    const symbols = await parseContent('animations.css', `
@keyframes fadeIn {
  from { opacity: 0; }
  to   { opacity: 1; }
}

@keyframes slide-in-right {
  from { transform: translateX(100%); }
  to   { transform: translateX(0); }
}
`);
    expect(symbols.some((s) => s.name === 'fadeIn' && s.kind === 'function')).toBe(true);
    expect(symbols.some((s) => s.name === 'slide-in-right' && s.kind === 'function')).toBe(true);
  });

  it('extracts @layer definitions', async () => {
    const symbols = await parseContent('layers.css', `
@layer utilities {
  .mt-4 { margin-top: 1rem; }
}

@layer components {
  .btn { padding: 0.5rem 1rem; }
}
`);
    expect(symbols.some((s) => s.name === 'utilities' && s.kind === 'module')).toBe(true);
    expect(symbols.some((s) => s.name === 'components' && s.kind === 'module')).toBe(true);
  });

  it('skips comment lines', async () => {
    const symbols = await parseContent('commented.css', `
/* .fake-class { color: red; } */
.real-class { color: blue; }
`);
    const names = symbols.map((s) => s.name);
    expect(names).not.toContain('fake-class');
    expect(names).toContain('real-class');
  });
});

// ── SCSS ──────────────────────────────────────────────────────────────────────

describe('SCSS — mixins and variables', () => {
  it('extracts @mixin definitions', async () => {
    const symbols = await parseContent('mixins.scss', `
@mixin flex-center($direction: row) {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: $direction;
}

@mixin respond-to($breakpoint) {
  @media (max-width: $breakpoint) { @content; }
}
`);
    expect(symbols.some((s) => s.name === 'flex-center' && s.kind === 'function')).toBe(true);
    expect(symbols.some((s) => s.name === 'respond-to' && s.kind === 'function')).toBe(true);
  });

  it('extracts @function definitions', async () => {
    const symbols = await parseContent('functions.scss', `
@function rem($px) {
  @return $px / 16px * 1rem;
}

@function z-index($layer) {
  @return map-get($z-layers, $layer);
}
`);
    expect(symbols.some((s) => s.name === 'rem' && s.kind === 'function')).toBe(true);
    expect(symbols.some((s) => s.name === 'z-index' && s.kind === 'function')).toBe(true);
  });

  it('extracts SCSS $variables', async () => {
    const symbols = await parseContent('variables.scss', `
$brand-primary: #007bff;
$spacing-sm: 0.5rem;
$font-size-base: 16px;
$border-radius: 4px;
`);
    expect(symbols.some((s) => s.name === 'brand-primary' && s.kind === 'property')).toBe(true);
    expect(symbols.some((s) => s.name === 'spacing-sm' && s.kind === 'property')).toBe(true);
    expect(symbols.some((s) => s.name === 'font-size-base' && s.kind === 'property')).toBe(true);
  });

  it('extracts %placeholder selectors', async () => {
    const symbols = await parseContent('placeholders.scss', `
%clearfix {
  &::after {
    content: '';
    display: table;
    clear: both;
  }
}

%visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
}
`);
    expect(symbols.some((s) => s.name === 'clearfix' && s.kind === 'type')).toBe(true);
    expect(symbols.some((s) => s.name === 'visually-hidden' && s.kind === 'type')).toBe(true);
  });

  it('extracts CSS custom properties inside SCSS', async () => {
    const symbols = await parseContent('theme.scss', `
:root {
  --color-primary: #{$brand-primary};
  --spacing-base: #{$spacing-sm};
}
`);
    expect(symbols.some((s) => s.name === 'color-primary' && s.kind === 'property')).toBe(true);
    expect(symbols.some((s) => s.name === 'spacing-base' && s.kind === 'property')).toBe(true);
  });

  it('extracts class selectors in SCSS', async () => {
    const symbols = await parseContent('component.scss', `
.user-card {
  .user-card__name {
    font-weight: 600;
  }
  &:hover {
    box-shadow: 0 2px 8px rgba(0,0,0,0.1);
  }
}
`);
    expect(symbols.some((s) => s.name === 'user-card' && s.kind === 'class')).toBe(true);
    expect(symbols.some((s) => s.name === 'user-card__name' && s.kind === 'class')).toBe(true);
  });

  it('skips // comment lines', async () => {
    const symbols = await parseContent('skip-comments.scss', `
// $fake-var: red;
// @mixin fake-mixin() {}
$real-var: blue;
`);
    const names = symbols.map((s) => s.name);
    expect(names).not.toContain('fake-var');
    expect(names).not.toContain('fake-mixin');
    expect(names).toContain('real-var');
  });
});

// ── list_languages includes new languages ─────────────────────────────────────

describe('Language registry — HTML, CSS, SCSS registered', () => {
  it('getAllLanguages includes html, css, scss', async () => {
    const { getAllLanguages } = await import('../src/languages/LanguageRegistry');
    const names = getAllLanguages().map((l) => l.name);
    expect(names).toContain('html');
    expect(names).toContain('css');
    expect(names).toContain('scss');
  });

  it('getAllWatchedExtensions includes .html, .css, .scss, .sass', async () => {
    const { getAllWatchedExtensions } = await import('../src/languages/LanguageRegistry');
    const exts = getAllWatchedExtensions();
    expect(exts).toContain('.html');
    expect(exts).toContain('.css');
    expect(exts).toContain('.scss');
    expect(exts).toContain('.sass');
  });
});
