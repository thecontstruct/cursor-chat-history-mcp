import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildFtsExpression, searchFtsIndex } from './fts-index.js';

describe('fts-index', () => {
  let dir: string;
  let indexPath: string;

  const prevFts = process.env.CURSOR_CHAT_FTS;
  beforeAll(() => {
    delete process.env.CURSOR_CHAT_FTS; // vitest config disables FTS globally
    dir = mkdtempSync(join(tmpdir(), 'fts-test-'));
    indexPath = join(dir, 'index.db');
    const db = new Database(indexPath);
    db.exec(`
      CREATE TABLE msgs(id INTEGER PRIMARY KEY, key TEXT UNIQUE, composer_id TEXT, kind TEXT, role INTEGER, ts INTEGER, src_rowid INTEGER);
      CREATE VIRTUAL TABLE fts USING fts5(text, tokenize='trigram');
    `);
    const add = (id: number, key: string, cid: string, text: string) => {
      db.prepare('INSERT INTO msgs VALUES(?,?,?,?,?,?,?)').run(id, key, cid, 'bubble', 1, null, id);
      db.prepare('INSERT INTO fts(rowid,text) VALUES(?,?)').run(id, text);
    };
    add(1, 'bubbleId:c1:b1', 'c1', 'We discussed the thinking budget for RI-195 today');
    add(2, 'bubbleId:c1:b2', 'c1', 'Another message about the Thinking Budget');
    add(3, 'bubbleId:c2:b1', 'c2', 'Unrelated talk about lint rules');
    add(4, 'bubbleId:c3:b1', 'c3', 'RI-195 follow up with "quotes" inside');
    db.close();
  });

  afterAll(() => {
    if (prevFts !== undefined) process.env.CURSOR_CHAT_FTS = prevFts;
    rmSync(dir, { recursive: true, force: true });
  });

  it('builds expressions and rejects terms shorter than 3 chars', () => {
    expect(buildFtsExpression({ query: 'RI-195' })).toBe('"RI-195"');
    expect(buildFtsExpression({ keywords: ['a1b', 'cde'], keywordOperator: 'AND' })).toBe('("a1b" AND "cde")');
    expect(buildFtsExpression({ query: 'ab' })).toBeNull();
    expect(buildFtsExpression({})).toBeNull();
  });

  it('finds conversations case-insensitively, newest first, grouped', () => {
    const hits = searchFtsIndex({ query: 'thinking budget', limit: 10, indexPath });
    expect(hits).not.toBeNull();
    expect(hits!.map(h => h.composerId)).toEqual(['c1']);
    expect(hits![0].matches).toHaveLength(2);
    expect(hits![0].matches[0].snippet.toLowerCase()).toContain('thinking budget');
  });

  it('respects limit and escapes quotes', () => {
    const hits = searchFtsIndex({ query: 'RI-195', limit: 1, indexPath });
    expect(hits!.map(h => h.composerId)).toEqual(['c3']);
    expect(searchFtsIndex({ query: '"quotes"', limit: 5, indexPath })!.map(h => h.composerId)).toEqual(['c3']);
  });

  it('supports AND/OR keywords', () => {
    expect(searchFtsIndex({ keywords: ['RI-195', 'lint rules'], keywordOperator: 'OR', limit: 10, indexPath })!.length).toBe(3);
    expect(searchFtsIndex({ keywords: ['RI-195', 'quotes'], keywordOperator: 'AND', limit: 10, indexPath })!.map(h => h.composerId)).toEqual(['c3']);
  });

  it('returns null (fallback) when the index is missing or the term is too short', () => {
    expect(searchFtsIndex({ query: 'RI-195', limit: 5, indexPath: join(dir, 'nope.db') })).toBeNull();
    expect(searchFtsIndex({ query: 'ab', limit: 5, indexPath })).toBeNull();
  });

  it('returns null when disabled by env', () => {
    process.env.CURSOR_CHAT_FTS = '0';
    try {
      expect(searchFtsIndex({ query: 'RI-195', limit: 5, indexPath })).toBeNull();
    } finally {
      delete process.env.CURSOR_CHAT_FTS;
    }
  });
});
