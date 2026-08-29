import type { PromptRegistry } from "../../framework/prompts/promptRegistry.js";
import type { AgentPlannerInput } from "../types.js";

const ALWAYS_INCLUDED = new Set([
  "canon.identity",
  "canon.authority",
  "canon.privacy",
  "runtime.tools.core",
  "runtime.context",
  "runtime.responses",
  "domain.choir.operations",
  "domain.choir.time",
  "deployment.echo.identity",
]);

/** Selects prompt policy from runtime state instead of adding another classifier call. */
export function createDynamicPromptResolver(registry: PromptRegistry, packIds: string[]) {
  return (input: AgentPlannerInput): string => {
    const activeCapabilities = new Set(input.toolCatalog.map((tool) => tool.capability));
    const usedTools = new Set(input.previousSteps.flatMap((step) =>
      step.decision.kind === "tool" ? [step.decision.toolName] : [],
    ));
    const scheduled = input.event.source === "scheduler" || input.event.source === "system";
    const retrievalActive = scheduled || [
      "retrieve_choir_knowledge",
      "read_week_schedule",
      "sync_if_stale",
      "inspect_spreadsheet",
      "query_spreadsheet",
    ].some((tool) => usedTools.has(tool));

    return registry.composeSelected(packIds, (layer) => {
      if (ALWAYS_INCLUDED.has(layer.id)) return true;
      if (layer.id === "runtime.workflows") return activeCapabilities.has("workflow");
      if (layer.id === "runtime.memory") return activeCapabilities.has("memory");
      if (layer.id === "runtime.members") {
        return activeCapabilities.has("identity") || activeCapabilities.has("administration");
      }
      if (layer.id === "runtime.scheduler") return scheduled;
      if (layer.id === "runtime.scheduled-tasks") return input.event.type === "scheduled_agent_task_due";
      if (layer.id === "domain.choir.retrieval-grounding") return retrievalActive;
      if (layer.id === "domain.choir.scheduled-events") return scheduled;
      return false;
    });
  };
}
