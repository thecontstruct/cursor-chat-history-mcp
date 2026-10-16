import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/**
 * Optional fast path for search_conversations.
 *
 * Reads a local SQLite FTS5 (trigram tokenizer) index of chat text, built outside this server
 * (see cursor-chat-history-cli: cch_index.py). The index is opened read-only. If it is missing,
 * unreadable, or the query is unsupported, callers fall back to the original scan.
 *
 * Schema: msgs(id, key, composer_id, kind, role, ts, src_rowid), fts(text) with rowid = msgs.id.
 * Disable with CURSOR_CHAT_FTS=0. Override location with CURSOR_CHAT_INDEX_PATH.
 */

export interface FtsMatch {
  key: string;
  kind: string;
  snippet: string;
}

export interface FtsConversationHit {
  composerId: string;
  matches: FtsMatch[];
}

export interface FtsSearchOptions {
  query?: string;
  keywords?: string[];
  keywordOperator?: 'AND' | 'OR';
  limit: number;
  matchesPerConversation?: number;
  indexPath?: string;
}

export function getFtsIndexPath(override?: string): string {
  return override || process.env.CURSOR_CHAT_INDEX_PATH || join(homedir(), '.cursor-chat-history-index', 'index.db');
}

export function isFtsEnabled(indexPath?: string): boolean {
  if (process.env.CURSOR_CHAT_FTS === '0') return false;
  return existsSync(getFtsIndexPath(indexPath));
}

function quote(term: string): string {
  return '"' + term.replace(/"/g, '""') + '"';
}

/** Returns the FTS MATCH expression, or null when the terms can't be served (trigram needs >= 3 chars). */
export function buildFtsExpression(opts: Pick<FtsSearchOptions, 'query' | 'keywords' | 'keywordOperator'>): string | null {
  const parts: string[] = [];
  const query = opts.query?.trim();
  if (query) parts.push(quote(query));
  const keywords = (opts.keywords ?? []).map(k => k.trim()).filter(Boolean);
  if (keywords.length) {
    const joined = keywords.map(quote).join(opts.keywordOperator === 'AND' ? ' AND ' : ' OR ');
    parts.push(keywords.length > 1 ? `(${joined})` : joined);
  }
  if (!parts.length) return null;
  const all = [query, ...keywords].filter((t): t is string => !!t);
  if (all.some(t => t.length < 3)) return null;
  // The original search ORs the query condition with the keyword condition.
  return parts.join(' OR ');
}

function makeSnippet(text: string, terms: string[], radius = 120): string {
  const low = text.toLowerCase();
  let pos = 0;
  for (const t of terms) {
    const p = low.indexOf(t.toLowerCase());
    if (p >= 0) { pos = p; break; }
  }
  return text.slice(Math.max(0, pos - radius), pos + radius).replace(/\s+/g, ' ');
}

/**
 * Search the FTS index. Returns conversations (newest first) or null if the index can't be used.
 */
export function searchFtsIndex(opts: FtsSearchOptions): FtsConversationHit[] | null {
  const expr = buildFtsExpression(opts);
  if (!expr || !isFtsEnabled(opts.indexPath)) return null;
  const terms = [opts.query, ...(opts.keywords ?? [])].filter((t): t is string => !!t);
  const per = opts.matchesPerConversation ?? 3;
  let db: Database.Database | undefined;
  try {
    db = new Database(getFtsIndexPath(opts.indexPath), { readonly: true, fileMustExist: true });
    const stmt = db.prepare(
      `SELECT m.composer_id AS cid, m.key AS key, m.kind AS kind, f.text AS text
       FROM fts f JOIN msgs m ON m.id = f.rowid
       WHERE fts MATCH ? AND m.composer_id IS NOT NULL
       ORDER BY m.src_rowid DESC`
    );
    const hits = new Map<string, FtsConversationHit>();
    for (const row of stmt.iterate(expr) as IterableIterator<{ cid: string; key: string; kind: string; text: string }>) {
      let hit = hits.get(row.cid);
      if (!hit) {
        if (hits.size >= opts.limit) break;
        hit = { composerId: row.cid, matches: [] };
        hits.set(row.cid, hit);
      }
      if (hit.matches.length < per) {
        hit.matches.push({ key: row.key, kind: row.kind, snippet: makeSnippet(row.text, terms) });
      }
    }
    return [...hits.values()];
  } catch {
    return null; // unreadable / no FTS5 trigram support / schema mismatch -> fall back
  } finally {
    db?.close();
  }
}
