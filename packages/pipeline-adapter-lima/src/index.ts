import { spawn } from "node:child_process";
import type { NormalizedTask } from "@async/pipeline-core";
import type { CommandExecutor, CommandResult } from "@async/pipeline-node";

export class LimaCommandExecutor implements CommandExecutor {
  name = "lima";

  constructor(private readonly vm = "async-pipeline") {}

  runShell(command: string, options: { cwd: string; env: NodeJS.ProcessEnv; task: NormalizedTask; timeoutMs?: number }): Promise<CommandResult> {
    const vm = options.task.environment?.vm ?? this.vm;
    const escaped = shellEscape(`cd ${shellEscape(options.cwd)} && ${command}`);
    return runProcess(`limactl shell ${shellEscape(vm)} -- bash -lc ${escaped}`, { cwd: options.cwd, env: options.env, timeoutMs: options.timeoutMs });
  }

  async checkTool(tool: string): Promise<boolean> {
    const result = await runProcess(`limactl shell ${shellEscape(this.vm)} -- bash -lc ${shellEscape(`command -v ${shellEscape(tool)}`)}`, {
      cwd: process.cwd(),
      env: process.env
    });
    return result.code === 0;
  }
}

function runProcess(command: string, options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: options.cwd,
      env: options.env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKillTimeout: NodeJS.Timeout | undefined;

    if (options.timeoutMs) {
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        forceKillTimeout = setTimeout(() => child.kill("SIGKILL"), 500);
      }, options.timeoutMs);
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
      if (timedOut) {
        resolve({ code: 124, stdout, stderr: `${stderr}[timeout] Command timed out after ${options.timeoutMs}ms.\n`, timedOut: true });
        return;
      }
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
