const tty = process.stdout.isTTY;
const c = (code: number, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);

let progressActive = false;
let lastPlain = 0;

function clearProgress() {
  if (progressActive && tty) process.stdout.write('\r\x1b[2K');
  progressActive = false;
}

export const log = {
  step(msg: string) {
    clearProgress();
    console.log(`${c(36, '>')} ${msg}`);
  },
  info(msg: string) {
    clearProgress();
    console.log(`  ${c(90, msg)}`);
  },
  warn(msg: string) {
    clearProgress();
    console.warn(`${c(33, 'warning')} ${msg}`);
  },
  error(msg: string) {
    clearProgress();
    console.error(`${c(31, 'error')} ${msg}`);
  },
  success(msg: string) {
    clearProgress();
    console.log(`${c(32, 'done')} ${msg}`);
  },
  progress(msg: string) {
    if (tty) {
      process.stdout.write(`\r\x1b[2K  ${msg}`);
      progressActive = true;
    } else {
      // Logs and pipes get one progress line every 10 seconds instead of a stream of them.
      const now = Date.now();
      if (now - lastPlain >= 10000) {
        lastPlain = now;
        console.log(`  ${msg}`);
      }
    }
  },
  progressDone() {
    if (progressActive && tty) process.stdout.write('\n');
    progressActive = false;
  },
};
