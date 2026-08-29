import { DateTime } from "luxon";
import { logData } from "../logger/execLogger.js";
import { clockService } from "../shared/clockService.js";

export interface WorkflowMetadata {
  workflowType: "reminder";
  workflowId: string;
  ownerId: string;
  workflowState: string;
  confirmationMessageId: string;
  createdAt: string;
  expiresAt: string;
}

const DEFAULT_TTL_HOURS = 24;

export class WorkflowCache {
  private readonly workflows = new Map<string, WorkflowMetadata>();

  public set(input: Omit<WorkflowMetadata, "createdAt" | "expiresAt">, ttlHours = DEFAULT_TTL_HOURS): void {
    const now = clockService.now("Europe/London");
    const metadata: WorkflowMetadata = {
      ...input,
      createdAt: now.toISO()!,
      expiresAt: now.plus({ hours: ttlHours }).toISO()!,
    };
    this.workflows.set(input.confirmationMessageId, metadata);
    logData(metadata, "Workflow cache entry stored");
  }

  public get(confirmationMessageId: string): WorkflowMetadata | null {
    this.pruneExpired();
    return this.workflows.get(confirmationMessageId) ?? null;
  }

  public remove(confirmationMessageId: string | undefined): void {
    if (!confirmationMessageId) return;
    const deleted = this.workflows.delete(confirmationMessageId);
    logData({ confirmationMessageId, deleted }, "Workflow cache entry removed");
  }

  public removeByWorkflowId(workflowId: string): void {
    for (const [messageId, metadata] of this.workflows.entries()) {
      if (metadata.workflowId === workflowId) {
        this.remove(messageId);
      }
    }
  }

  public pruneExpired(now = clockService.now("Europe/London")): void {
    for (const [messageId, metadata] of this.workflows.entries()) {
      if (DateTime.fromISO(metadata.expiresAt) <= now) {
        this.workflows.delete(messageId);
      }
    }
  }

  public size(): number {
    this.pruneExpired();
    return this.workflows.size;
  }

  public clear(): void {
    this.workflows.clear();
  }
}
