import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { applyOps, serialize, type EditOp } from '../spec/ops';

export { parseOps } from '../spec/ops';

/** Replaces the file in one step so readers (the preview, other editors) never see half a file. */
async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text);
  try {
    await rename(tmp, file);
  } catch {
    // Windows refuses the rename while another process holds the file open; fall back to a plain write.
    await writeFile(file, text);
    await unlink(tmp).catch(() => {});
  }
}

/** Applies editor operations to a spec file, keeping undo and redo history. Edits are serialized. */
export class SpecEditor {
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private file: string) {}

  /** Applies the ops and returns the new file text. */
  apply(ops: EditOp[]): Promise<string> {
    return this.enqueue(async () => {
      const before = await readFile(this.file, 'utf8');
      let spec: Record<string, unknown>;
      try {
        spec = JSON.parse(before);
      } catch (e) {
        throw new Error(`The spec file is not valid JSON: ${(e as Error).message}`);
      }
      const after = serialize(applyOps(spec, ops));
      if (after === before) return before;
      this.undoStack.push(before);
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack = [];
      await writeAtomic(this.file, after);
      return after;
    });
  }

  /**
   * Records a change made to the file by something else (the auto director's revision): `before` is
   * the text it replaced, so one undo brings it back.
   */
  record(before: string): Promise<void> {
    return this.enqueue(async () => {
      this.undoStack.push(before);
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack = [];
    });
  }

  /** Returns the restored file text, or null when there is nothing to undo. */
  undo(): Promise<string | null> {
    return this.swap(this.undoStack, this.redoStack);
  }

  redo(): Promise<string | null> {
    return this.swap(this.redoStack, this.undoStack);
  }

  private swap(from: string[], to: string[]): Promise<string | null> {
    return this.enqueue(async () => {
      const text = from.pop();
      if (text === undefined) return null;
      to.push(await readFile(this.file, 'utf8'));
      await writeAtomic(this.file, text);
      return text;
    });
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const p = this.queue.then(run);
    this.queue = p.catch(() => {});
    return p;
  }
}
