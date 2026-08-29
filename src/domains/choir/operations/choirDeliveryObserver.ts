import type { ScheduledDeliveryObserver, ScheduledMessagePolicy, ChoirWorkflowService } from "../../../agent/ports.js";
import type { AgentEvent, AgentTurnResult } from "../../../agent/types.js";

/** Applies choir state transitions only after the transport confirms delivery. */
export class ChoirDeliveryObserver implements ScheduledDeliveryObserver, ScheduledMessagePolicy {
  public constructor(private readonly workflows: ChoirWorkflowService) {}

  public async onDelivered(event: AgentEvent): Promise<void> {
    if (event.type !== "setlist_broadcast_due") return;
    const submissionId = event.payload.submissionId;
    if (typeof submissionId === "string") await this.workflows.markSetlistBroadcastSent(submissionId);
  }

  public canDeliver(event: AgentEvent, result: AgentTurnResult): boolean {
    const requiredTools = REQUIRED_DELIVERY_TOOLS[event.type];
    if (!requiredTools) return true;
    const successful = new Set(result.steps
      .filter((step) => step.decision.kind === "tool" && step.result?.status === "success")
      .map((step) => step.decision.kind === "tool" ? step.decision.toolName : ""));
    return requiredTools.every((tool) => successful.has(tool));
  }
}

const REQUIRED_DELIVERY_TOOLS: Readonly<Record<string, string[]>> = {
  weekly_rota_reminder_due: ["prepare_sunday_rota_reminder"],
  midweek_rota_reminder_due: ["prepare_midweek_rota_reminder"],
  setlist_followup_due: ["prepare_setlist_nudge"],
  setlist_broadcast_due: ["prepare_setlist_broadcast"],
};
