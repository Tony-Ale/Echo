import type { AgentPlanner, AgentPlannerInput, AgentDecision } from "../types.js";
import { PlannerProtocolError } from "./langChainPlanner.js";

// Three low-risk decisions cover the common inspect -> query -> answer shape.
// Longer turns have become materially more complex and return to the primary
// planner instead of shifting an unbounded agent loop onto the fast model.
const MAX_FAST_DECISIONS_PER_TURN = 3;

/** Routes by runtime capability and side-effect risk, never by user vocabulary. */
export class RoutingAgentPlanner implements AgentPlanner {
  public readonly modelName: string;

  public constructor(
    private readonly primary: AgentPlanner,
    private readonly fast: AgentPlanner,
  ) {
    this.modelName = `${primary.modelName}|${fast.modelName}`;
  }

  public async decide(input: AgentPlannerInput, signal: AbortSignal): Promise<AgentDecision> {
    const selected = this.select(input);
    try {
      return await selected.decide(input, signal);
    } catch (error) {
      // A model can occasionally satisfy the outer structured schema while
      // returning unusable tool arguments. The primary planner already gets
      // one repair attempt; after that, use the configured fast planner once.
      // This is bounded orchestration recovery, not a tool or agent loop.
      if (selected === this.primary && error instanceof PlannerProtocolError && !signal.aborted) {
        return this.fast.decide(input, signal);
      }
      throw error;
    }
  }

  private select(input: AgentPlannerInput): AgentPlanner {
    if (requiresOperationalJudgment(input)) return this.primary;
    if (input.previousSteps.length >= MAX_FAST_DECISIONS_PER_TURN) return this.primary;
    return this.fast;
  }
}

function requiresOperationalJudgment(input: AgentPlannerInput): boolean {
  if (input.context.activeObligations.length > 0) return true;
  if (input.toolCatalog.some((tool) =>
    tool.capability === "workflow"
    || tool.capability === "administration"
    || tool.sideEffect === "write"
    || tool.sideEffect === "message"
  )) return true;
  return input.previousSteps.some((step) =>
    step.result?.status === "approval_required"
    || step.result?.status === "denied"
    || step.result?.status === "error"
  );
}
