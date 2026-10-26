import { readFile, writeFile } from 'node:fs/promises';

/**
 * Review comments left in the preview at a moment of the video ("this feels slow"), stored next to the
 * spec in <name>.comments.json. `bemotion comments` lists them and `review --comments` hands the open
 * ones to Claude to fix.
 */
export interface Comment {
  id: string;
  /** Output seconds where it was left. */
  t: number;
  /** The scene (id, or "scene N") and the time inside it, as written in the spec. */
  scene: string;
  sceneTime: number;
  /** The layer selected when it was left (a JSON path into the spec), and its name. */
  layer?: (string | number)[];
  layerName?: string;
  text: string;
  resolved?: boolean;
  created: string;
}

export type CommentOp =
  | { op: 'add'; t: number; scene: string; sceneTime: number; layer?: (string | number)[]; layerName?: string; text: string }
  | { op: 'resolve'; id: string; resolved: boolean }
  | { op: 'delete'; id: string };

export function commentsPath(specPath: string): string {
  return specPath.replace(/\.json$/i, '') + '.comments.json';
}

export async function readComments(specPath: string): Promise<Comment[]> {
  try {
    const list = JSON.parse(await readFile(commentsPath(specPath), 'utf8'));
    return Array.isArray(list) ? (list as Comment[]) : [];
  } catch {
    return [];
  }
}

let counter = 0;

/** Applies one change and saves; returns the list sorted by time. */
export async function applyComment(specPath: string, op: CommentOp): Promise<Comment[]> {
  const list = await readComments(specPath);
  if (op.op === 'add') {
    const text = String(op.text ?? '').trim().slice(0, 2000);
    if (!text) throw new Error('A comment needs some text');
    if (!Number.isFinite(op.t)) throw new Error('A comment needs a time');
    list.push({
      id: `${Date.now().toString(36)}${(counter++).toString(36)}`,
      t: Math.max(0, Number(op.t)),
      scene: String(op.scene ?? '').slice(0, 120),
      sceneTime: Number(op.sceneTime) || 0,
      ...(Array.isArray(op.layer) ? { layer: op.layer.filter((p) => typeof p === 'string' || typeof p === 'number').slice(0, 20) } : {}),
      ...(op.layerName ? { layerName: String(op.layerName).slice(0, 120) } : {}),
      text,
      created: new Date().toISOString(),
    });
  } else if (op.op === 'resolve') {
    const c = list.find((x) => x.id === op.id);
    if (c) c.resolved = !!op.resolved;
  } else if (op.op === 'delete') {
    const i = list.findIndex((x) => x.id === op.id);
    if (i >= 0) list.splice(i, 1);
  } else {
    throw new Error('Unknown comment change');
  }
  list.sort((a, b) => a.t - b.t);
  await writeFile(commentsPath(specPath), JSON.stringify(list, null, 2) + '\n');
  return list;
}

/** One line per comment: when, where, on what, and what. */
export function commentLines(list: Comment[], all = false): string[] {
  return list
    .filter((c) => all || !c.resolved)
    .map((c) => `${c.t.toFixed(2)}s [${c.scene} at ${c.sceneTime.toFixed(2)}s]${c.layerName ? ` on ${c.layerName}` : ''}${c.layer ? ` (${c.layer.join('.')})` : ''}${c.resolved ? ' (resolved)' : ''}: ${c.text}`);
}
