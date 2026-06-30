import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// Module-level cache built once per process (~16ms scan over ~900 dirs)
let _index: Map<string, string> | null = null;

/**
 * Decode a Cursor workspace slug to a cwd path.
 * Cursor encodes cwd as: strip leading '/', replace '/' with '-'.
 * We reverse: prepend '/', replace '-' with '/'.
 *
 * Limitation: directory names that contain '-' are ambiguous and will be
 * mangled (the '-' becomes '/'). Accept this; consumers use the last segment
 * or the worktree repo segment for display, both of which survive the mangle.
 */
export function decodeWorkspaceSlug(slug: string): string {
  return '/' + slug.replace(/-/g, '/');
}

function buildIndex(): Map<string, string> {
  const index = new Map<string, string>();
  const projectsDir = join(homedir(), '.cursor', 'projects');
  if (!existsSync(projectsDir)) return index;

  let workspaceEntries;
  try {
    workspaceEntries = readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return index;
  }

  for (const entry of workspaceEntries) {
    if (!entry.isDirectory()) continue;
    const name = String(entry.name);
    // Skip numeric-only dirs (Cursor uses those for canvases, not agent-transcripts)
    if (/^\d+$/.test(name)) continue;

    const atDir = join(projectsDir, name, 'agent-transcripts');
    if (!existsSync(atDir)) continue;

    let composerEntries;
    try {
      composerEntries = readdirSync(atDir, { withFileTypes: true });
    } catch {
      continue;
    }

    const cwd = decodeWorkspaceSlug(name);

    for (const composerEntry of composerEntries) {
      if (!composerEntry.isDirectory()) continue;
      const id = String(composerEntry.name);
      // Skip agent-sub-call dirs (prefixed with 'agent-')
      if (id.startsWith('agent-')) continue;

      const existing = index.get(id);
      // Prefer a real workspace over the 'empty-window' catch-all
      if (!existing || existing === '/empty/window') {
        index.set(id, cwd);
      }
    }
  }

  return index;
}

/**
 * Look up the decoded cwd for a Cursor composer ID by scanning
 * ~/.cursor/projects/<slug>/agent-transcripts/<composerId>.
 * Returns empty string if not found.
 * Result is cached after the first call.
 */
export function getCursorProjectPath(composerId: string): string {
  if (!_index) _index = buildIndex();
  return _index.get(composerId) ?? '';
}
