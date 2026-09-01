import type { MemberRole } from "../../agent/types.js";

export type PublicCapabilityKind = "conversation" | "knowledge" | "workflow" | "automatic" | "administration";

/** User-facing documentation for one capability in an agent deployment. */
export interface PublicCapability {
  id: string;
  title: string;
  summary: string;
  kind: PublicCapabilityKind;
  minimumRole: MemberRole;
  examples: readonly string[];
  notes?: readonly string[];
  helpText?: string;
}

/** Authoritative, role-aware catalogue shared by help text and agent tools. */
export class CapabilityRegistry {
  private readonly capabilities: readonly PublicCapability[];

  public constructor(capabilities: readonly PublicCapability[]) {
    const ids = new Set<string>();
    for (const capability of capabilities) {
      if (ids.has(capability.id)) throw new Error(`Capability '${capability.id}' is already registered.`);
      ids.add(capability.id);
    }
    this.capabilities = [...capabilities];
  }

  public listForRoles(roles: readonly MemberRole[]): readonly PublicCapability[] {
    return this.capabilities.filter((capability) => hasMinimumRole(roles, capability.minimumRole));
  }
}

function hasMinimumRole(roles: readonly MemberRole[], minimumRole: MemberRole): boolean {
  if (minimumRole === "member") return roles.length > 0;
  if (minimumRole === "superuser") return roles.includes("superuser") || roles.includes("creator");
  return roles.includes("creator");
}
