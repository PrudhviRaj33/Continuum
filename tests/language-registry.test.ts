import { describe, it, expect, beforeAll } from 'vitest';
import {
  getLanguageByExtension,
  getAllWatchedExtensions,
  getAllLanguages,
} from '../src/languages/LanguageRegistry';

describe('LanguageRegistry', () => {
  beforeAll(async () => {
    // Registry auto-loads on import — just verify it populated
  });

  it('should have at least 14 languages registered', () => {
    const langs = getAllLanguages();
    expect(langs.length).toBeGreaterThanOrEqual(14);
  });

  it('should resolve TypeScript extensions', () => {
    expect(getLanguageByExtension('.ts')?.name).toBe('typescript');
    expect(getLanguageByExtension('.tsx')?.name).toBe('typescript');
  });

  it('should resolve JavaScript extensions', () => {
    expect(getLanguageByExtension('.js')?.name).toBe('javascript');
    expect(getLanguageByExtension('.jsx')?.name).toBe('javascript');
    expect(getLanguageByExtension('.mjs')?.name).toBe('javascript');
  });

  it('should resolve Python extensions', () => {
    expect(getLanguageByExtension('.py')?.name).toBe('python');
    expect(getLanguageByExtension('.pyw')?.name).toBe('python');
  });

  it('should resolve Rust extension', () => {
    expect(getLanguageByExtension('.rs')?.name).toBe('rust');
  });

  it('should resolve Go extension', () => {
    expect(getLanguageByExtension('.go')?.name).toBe('go');
  });

  it('should resolve Java extension', () => {
    expect(getLanguageByExtension('.java')?.name).toBe('java');
  });

  it('should resolve C# extension', () => {
    expect(getLanguageByExtension('.cs')?.name).toBe('csharp');
  });

  it('should resolve C/C++ extensions', () => {
    expect(getLanguageByExtension('.cpp')?.name).toBe('cpp');
    expect(getLanguageByExtension('.c')?.name).toBe('cpp');
    expect(getLanguageByExtension('.h')?.name).toBe('cpp');
  });

  it('should resolve Ruby extension', () => {
    expect(getLanguageByExtension('.rb')?.name).toBe('ruby');
  });

  it('should resolve PHP extension', () => {
    expect(getLanguageByExtension('.php')?.name).toBe('php');
  });

  it('should resolve Swift extension', () => {
    expect(getLanguageByExtension('.swift')?.name).toBe('swift');
  });

  it('should resolve Kotlin extension', () => {
    expect(getLanguageByExtension('.kt')?.name).toBe('kotlin');
  });

  it('should resolve SQL extension', () => {
    expect(getLanguageByExtension('.sql')?.name).toBe('sql');
  });

  it('should resolve Markdown extensions', () => {
    expect(getLanguageByExtension('.md')?.name).toBe('markdown');
    expect(getLanguageByExtension('.mdx')?.name).toBe('markdown');
  });

  it('should return undefined for unknown extensions', () => {
    expect(getLanguageByExtension('.xyz')).toBeUndefined();
    expect(getLanguageByExtension('.bin')).toBeUndefined();
  });

  it('should be case-insensitive for extensions', () => {
    expect(getLanguageByExtension('.TS')?.name).toBe('typescript');
    expect(getLanguageByExtension('.PY')?.name).toBe('python');
  });

  it('all languages should have at least one rule', () => {
    const langs = getAllLanguages();
    for (const lang of langs) {
      expect(lang.rules.length, `${lang.name} has no rules`).toBeGreaterThan(0);
    }
  });

  it('getAllWatchedExtensions should include common extensions', () => {
    const exts = getAllWatchedExtensions();
    expect(exts).toContain('.ts');
    expect(exts).toContain('.py');
    expect(exts).toContain('.rs');
    expect(exts).toContain('.go');
    expect(exts).toContain('.java');
  });
});
