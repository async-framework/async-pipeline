import { HostCommandExecutor } from "./runner.js";

export interface DoctorCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
}

export async function runDoctor(): Promise<DoctorCheck[]> {
  const host = new HostCommandExecutor();
  const checks: DoctorCheck[] = [];

  for (const tool of ["node", "pnpm"]) {
    const available = await host.checkTool(tool);
    checks.push({
      name: tool,
      status: available ? "pass" : "fail",
      message: available ? `${tool} is available.` : `${tool} is missing.`
    });
  }

  const limaAvailable = await host.checkTool("limactl");
  checks.push({
    name: "limactl",
    status: limaAvailable ? "pass" : "warn",
    message: limaAvailable ? "Lima is available." : "Lima is not installed; Lima-backed tasks will be unavailable."
  });

  return checks;
}
