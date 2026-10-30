import { describe, expect, it } from 'vitest';
import pkg from '../../package.json';
import readme from '../../README.md?raw';
import llms from '../../llms.txt?raw';

// `llms.txt` is the quick feature and usage guide for AI assistants. It ships in the npm tarball (the per-module
// READMEs do not), so it must stay short, listed in `files`, linked from the README, and in the same order every time.
// Its code blocks are compiled by readme-typecheck.test.ts.

const SECTIONS = [
  /^## 1\. What it is/,
  /^## 2\. Install and first call/,
  /^## 3\. Feature map/,
  /^## 4\. Recipes/,
  /^## 5\. Defaults that bite/,
  /^## 6\. Rules for assistants/,
];

describe('llms.txt', () => {
  it('is listed in package.json files', () => {
    expect((pkg as { files: string[] }).files).toContain('llms.txt');
  });

  it('is at most 250 lines', () => {
    expect(llms.trimEnd().split('\n').length).toBeLessThanOrEqual(250);
  });

  it('is linked from the README', () => {
    expect(readme).toMatch(/\]\(llms\.txt\)/);
  });

  it('has the six section headings in order', () => {
    const headings = llms.split('\n').filter((l) => /^## /.test(l));
    expect(headings).toHaveLength(SECTIONS.length);
    SECTIONS.forEach((re, i) => expect(headings[i]).toMatch(re));
  });

  it('starts with the package name and names the host package it needs', () => {
    expect(llms.split('\n')[0]).toMatch(/^# @sokpheak\/sp-laravel-api/);
    expect(llms).toContain('sopheak/sp-laravel-api');
  });

  it('mentions every subpath module the package exports', () => {
    const subpaths = Object.keys((pkg as { exports: Record<string, unknown> }).exports)
      .filter((k) => k !== '.' && k !== './package.json')
      .map((k) => k.slice(1));
    for (const s of subpaths) expect(llms, s).toContain(`@sokpheak/sp-laravel-api${s}`);
  });

  it('names no forbidden client name when FORBIDDEN_NAMES is set', () => {
    const list = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.FORBIDDEN_NAMES;
    if (list === undefined || list.trim() === '') return;
    const text = llms.toLowerCase();
    for (const name of list.split(',').map((n) => n.trim().toLowerCase()).filter((n) => n !== '')) {
      expect(text.includes(name), 'a forbidden name appears in llms.txt').toBe(false);
    }
  });
});
