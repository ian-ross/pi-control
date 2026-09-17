import { spawn } from "node:child_process";
import path from "node:path";

export const CAPTURE_LIMIT_BYTES = 8 * 1024;
export const TRUNCATION_MARKER = "[pi-control: output truncated]\n";

export interface CommandResult {
  command: string;
  code: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
}

export interface RunCommandInput {
  command: string;
  shell: string;
  timeoutMs: number;
  cwd: string;
  signal?: AbortSignal;
}

class BoundedCapture {
  private buffer = Buffer.alloc(0);
  private truncated = false;

  append(chunk: Buffer | string): void {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (incoming.length === 0) return;

    const next = Buffer.concat([this.buffer, incoming]);
    if (next.length > CAPTURE_LIMIT_BYTES) {
      this.truncated = true;
      this.buffer = next.subarray(next.length - CAPTURE_LIMIT_BYTES);
    } else {
      this.buffer = next;
    }
  }

  text(): string {
    if (!this.truncated) return this.buffer.toString("utf8");

    const marker = Buffer.from(TRUNCATION_MARKER);
    const tailLimit = Math.max(0, CAPTURE_LIMIT_BYTES - marker.length);
    return Buffer.concat([marker, this.buffer.subarray(Math.max(0, this.buffer.length - tailLimit))]).toString("utf8");
  }
}

export function boundOutput(value: string): string {
  const capture = new BoundedCapture();
  capture.append(value);
  return capture.text();
}

export function cancelledCommandResult(command: string, durationMs = 0): CommandResult {
  return {
    command,
    code: null,
    durationMs,
    stdout: "",
    stderr: "",
    timedOut: false,
    cancelled: true,
  };
}

function shellArgs(command: string): string[] {
  if (process.platform === "win32") return ["/d", "/s", "/c", command];
  return ["-lc", command];
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process may already have exited.
    }
  }
}

export async function runCommand(input: RunCommandInput): Promise<CommandResult> {
  const started = Date.now();
  if (input.signal?.aborted) return cancelledCommandResult(input.command);

  const stdout = new BoundedCapture();
  const stderr = new BoundedCapture();
  let timedOut = false;
  let cancelled = false;
  let settled = false;
  let killTimer: NodeJS.Timeout | undefined;

  return await new Promise<CommandResult>((resolve) => {
    const child = spawn(input.shell, shellArgs(input.command), {
      cwd: input.cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if ((timedOut || cancelled) && child.pid !== undefined) killProcessGroup(child.pid, 'SIGKILL');
      input.signal?.removeEventListener("abort", abortListener);
      resolve({
        command: input.command,
        code: timedOut || cancelled ? null : code,
        durationMs: Date.now() - started,
        stdout: stdout.text(),
        stderr: stderr.text(),
        timedOut,
        cancelled,
      });
    };

    const terminate = (reason: "timeout" | "cancelled"): void => {
      if (settled) return;
      timedOut = reason === "timeout";
      cancelled = reason === "cancelled";
      if (child.pid === undefined) {
        finish(null);
        return;
      }
      killProcessGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => {
        if (child.pid !== undefined) killProcessGroup(child.pid, "SIGKILL");
      }, 250);
    };

    const abortListener = (): void => terminate("cancelled");
    const timeout = setTimeout(() => terminate("timeout"), input.timeoutMs);

    input.signal?.addEventListener("abort", abortListener, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));
    child.on("error", (error) => {
      stderr.append(`${error.name}: ${error.message}\n`);
      finish(null);
    });
    child.on("close", (code) => finish(code));
    if (input.signal?.aborted) abortListener();
  });
}

export interface CommandRunner {
  run(input: RunCommandInput): Promise<CommandResult>;
}

export const subprocessRunner: CommandRunner = { run: runCommand };

export function repoRootFromBaseline(baseline: unknown): string {
  const value = baseline as { root?: unknown } | null;
  const root = value?.root;
  if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0')) throw new Error('Verification requires a captured absolute repository root.');
  return root;
}
