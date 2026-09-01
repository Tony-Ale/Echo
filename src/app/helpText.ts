import type { MemberRole } from "../agent/types.js";
import { echoCapabilityRegistry } from "../deployments/echo/capabilities.js";

export function buildHelpMessage(roles: readonly MemberRole[] = ["member"]): string {
  const lines = ["Echo can help with:", ""];
  for (const capability of echoCapabilityRegistry.listForRoles(roles)) {
    if (!capability.helpText) continue;
    lines.push(`- ${capability.helpText}`, "");
  }
  lines.push("One-time reminder creation, edits, and cancellation require confirmation through Echo's reply chain.");
  return lines.join("\n");
}
