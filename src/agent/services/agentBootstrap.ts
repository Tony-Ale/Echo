import type { MemoryRepository } from "../ports.js";
import type { MemoryBlock } from "../types.js";

export type BootstrapMemoryBlock = Omit<MemoryBlock, "id" | "version">;

/** Ensures the small always-visible memory blocks exist without overwriting later edits. */
export class AgentBootstrapService {
  public constructor(
    private readonly memory: MemoryRepository,
    private readonly blocks: BootstrapMemoryBlock[],
  ) {}

  public async initialize(): Promise<void> {
    const existing = await this.memory.getBlocks({});
    const labels = new Set(existing.map((block) => block.label));
    for (const block of this.blocks) {
      if (!labels.has(block.label)) await this.memory.upsertBlock(block);
    }
  }
}
