import Anthropic from '@anthropic-ai/sdk';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from './log';

/** One piece of a user turn. Images carry their bytes; the Claude Code backend also needs a file path. */
export type Part =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: Buffer; file?: string };

/** A multi-turn conversation with Claude that the generate loop drives. */
export interface Backend {
  readonly name: string;
  send(parts: Part[], label: string): Promise<string>;
  summary(): string;
}

export const API_MODEL = 'claude-opus-5-5';

function ticker(label: string): () => void {
  const started = Date.now();
  const timer = setInterval(() => log.progress(`${label}  ${Math.round((Date.now() - started) / 1000)}s`), 500);
  return () => {
    clearInterval(timer);
    log.progressDone();
  };
}

/** The Claude API through the Anthropic SDK (needs ANTHROPIC_API_KEY or `ant auth login`). */
export class ApiBackend implements Backend {
  readonly name = `Claude API (${API_MODEL})`;
  private client = new Anthropic();
  private messages: Anthropic.Beta.BetaMessageParam[] = [];
  private usage = { input: 0, output: 0, cacheRead: 0 };

  constructor(
    private system: { role: string; reference: string },
    private effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' = 'high',
  ) {}

  async send(parts: Part[], label: string): Promise<string> {
    const content: Anthropic.Beta.BetaContentBlockParam[] = parts.map((p) =>
      p.type === 'text'
        ? { type: 'text', text: p.text }
        : { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data.toString('base64') } },
    );
    this.messages.push({ role: 'user', content });
    const started = Date.now();
    const stop = ticker(label);
    let msg: Anthropic.Beta.BetaMessage;
    try {
      const stream = this.client.beta.messages.stream({
        model: API_MODEL,
        max_tokens: 64000,
        thinking: { type: 'adaptive' },
        output_config: { effort: this.effort },
        // Re-route automatically if a safety classifier declines the request.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: [
          { type: 'text', text: this.system.role },
          // Stable prefix: cached across the generate, fix and review turns.
          { type: 'text', text: this.system.reference, cache_control: { type: 'ephemeral' } },
        ],
        messages: this.messages,
      });
      msg = await stream.finalMessage();
    } catch (e) {
      stop();
      if (e instanceof Anthropic.AuthenticationError) {
        throw new Error('Claude API authentication failed. Set ANTHROPIC_API_KEY, run `ant auth login`, or use --backend claude-code.');
      }
      if (e instanceof Anthropic.RateLimitError) throw new Error('Claude API rate limit reached. Try again shortly.');
      if (e instanceof Anthropic.APIError) throw new Error(`Claude API error ${e.status}: ${e.message}`);
      throw e;
    }
    stop();
    // Keep the full content (including thinking blocks) so later turns keep the model's reasoning.
    this.messages.push({ role: 'assistant', content: msg.content as Anthropic.Beta.BetaContentBlockParam[] });
    this.usage.input += msg.usage.input_tokens;
    this.usage.output += msg.usage.output_tokens;
    this.usage.cacheRead += msg.usage.cache_read_input_tokens ?? 0;
    if (msg.stop_reason === 'refusal') throw new Error(`Claude declined the request${msg.stop_details?.explanation ? `: ${msg.stop_details.explanation}` : ''}.`);
    if (msg.stop_reason === 'max_tokens') throw new Error('The response hit the output limit before the spec was complete.');
    log.info(`${label} finished in ${Math.round((Date.now() - started) / 1000)}s (${msg.usage.output_tokens} output tokens)`);
    return msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  }

  summary(): string {
    const u = this.usage;
    return `Tokens: ${u.input} input (${u.cacheRead} cached), ${u.output} output`;
  }
}

/**
 * Headless Claude Code (`claude -p`), which uses the signed-in Claude Code account, so no API key is
 * needed. Runs in safe mode (no user hooks, plugins or CLAUDE.md) with only the Read tool, which it
 * uses to look at reference images and review frames written to disk.
 */
export class ClaudeCodeBackend implements Backend {
  readonly name: string;
  private session: string | null = null;
  private cost = 0;
  private turns = 0;
  private sysFile: string;
  private n = 0;

  constructor(
    private system: { role: string; reference: string },
    private workDir: string,
    private model = 'opus',
    private effort: string = 'high',
  ) {
    this.name = `Claude Code (${model})`;
    this.sysFile = join(workDir, 'system-prompt.md');
  }

  static available(): boolean {
    const r = spawnSync('claude', ['--version'], { encoding: 'utf8', env: childEnv(), windowsHide: true });
    return r.status === 0;
  }

  async send(parts: Part[], label: string): Promise<string> {
    await mkdir(this.workDir, { recursive: true });
    if (!this.session) {
      const tools = '\n\nYou can only use the Read tool, and only to look at image files you are pointed to. Never edit files; reply in text.';
      await writeFile(this.sysFile, `${this.system.role}${tools}\n\n${this.system.reference}`);
    }
    // Images go to disk; the prompt tells Claude to Read them in order.
    const lines: string[] = [];
    for (const p of parts) {
      if (p.type === 'text') lines.push(p.text);
      else {
        let file = p.file;
        if (!file) {
          file = join(this.workDir, `image-${String(++this.n).padStart(3, '0')}.${p.mediaType.split('/')[1].replace('jpeg', 'jpg')}`);
          await writeFile(file, p.data);
        }
        lines.push(`[Image: use the Read tool to view ${file}]`);
      }
    }
    const args = [
      '-p',
      '--output-format', 'json',
      '--safe-mode',
      '--model', this.model,
      '--effort', this.effort,
      '--system-prompt-file', this.sysFile,
      '--tools', 'Read',
      '--allowedTools', 'Read',
      '--add-dir', this.workDir,
      ...(this.session ? ['--resume', this.session] : []),
    ];
    const started = Date.now();
    const stop = ticker(label);
    let out: string;
    try {
      out = await run('claude', args, lines.join('\n\n'), this.workDir);
    } finally {
      stop();
    }
    let result: { result?: string; session_id?: string; is_error?: boolean; subtype?: string; total_cost_usd?: number; num_turns?: number };
    try {
      result = JSON.parse(out);
    } catch {
      throw new Error(`Unexpected output from claude: ${out.slice(0, 400)}`);
    }
    if (result.is_error || result.subtype !== 'success') throw new Error(`Claude Code failed (${result.subtype ?? 'error'}): ${String(result.result ?? '').slice(0, 400)}`);
    this.session = result.session_id ?? this.session;
    this.cost += result.total_cost_usd ?? 0;
    this.turns++;
    log.info(`${label} finished in ${Math.round((Date.now() - started) / 1000)}s`);
    return result.result ?? '';
  }

  summary(): string {
    return `Claude Code session ${this.session ?? 'none'}, ${this.turns} turn(s), reported cost $${this.cost.toFixed(2)}`;
  }
}

/** Environment for a nested `claude` process (it refuses to start inside another session otherwise). */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

function run(cmd: string, args: string[], input: string, cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, env: childEnv(), windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => reject(new Error(`Could not start ${cmd}: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0 || stdout.trim().startsWith('{')) resolvePromise(stdout);
      else reject(new Error(`${cmd} exited with code ${code}: ${(stderr || stdout).slice(0, 600)}`));
    });
    child.stdin.end(input);
  });
}
