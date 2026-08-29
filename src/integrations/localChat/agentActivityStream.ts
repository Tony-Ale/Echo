import type { AgentActivitySink } from "../../agent/ports.js";
import type { AgentActivityEvent } from "../../agent/types.js";
import { clockService } from "../../shared/clockService.js";

type ActivityListener = (event: AgentActivityEvent) => void;

/** Small bounded runtime buffer for the local staging UI. */
export class AgentActivityStream implements AgentActivitySink {
  private readonly events: AgentActivityEvent[] = [];
  private readonly listeners = new Set<ActivityListener>();

  public constructor(private readonly limit = 200) {}

  public publish(event: AgentActivityEvent): void {
    this.events.push(event);
    if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit);
    for (const listener of this.listeners) listener(event);
  }

  public list(): AgentActivityEvent[] {
    return [...this.events];
  }

  public clear(): void {
    this.events.length = 0;
  }

  /**
   * Returns the activity visible at a simulated point in time. Events remain
   * buffered so moving the clock forward can reveal them again.
   */
  public listThrough(timestamp: number): AgentActivityEvent[] {
    return this.events.filter((event) => {
      const occurredAt = clockService.Date(event.occurredAt).getTime();
      return Number.isFinite(occurredAt) && occurredAt <= timestamp;
    });
  }

  public subscribe(listener: ActivityListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
