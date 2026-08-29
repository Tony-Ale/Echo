import type { PromptLayer, PromptPack } from "./types.js";

/** Versionable prompt library assembled from explicit deployment-selected packs. */
export class PromptRegistry {
  private readonly packs = new Map<string, PromptPack>();

  public register(pack: PromptPack): void {
    if (this.packs.has(pack.id)) throw new Error(`Prompt pack '${pack.id}' is already registered.`);
    validatePack(pack);
    this.packs.set(pack.id, pack);
  }

  public compose(packIds: string[]): string {
    return this.composeSelected(packIds, () => true);
  }

  /** Composes only the layers needed by the current event and active capabilities. */
  public composeSelected(packIds: string[], include: (layer: PromptLayer) => boolean): string {
    const layers: PromptLayer[] = [];
    for (const packId of packIds) {
      const pack = this.packs.get(packId);
      if (!pack) throw new Error(`Prompt pack '${packId}' is not registered.`);
      layers.push(...pack.layers);
    }
    const unique = new Map<string, PromptLayer>();
    for (const layer of layers) {
      if (unique.has(layer.id)) throw new Error(`Prompt layer '${layer.id}' was included more than once.`);
      unique.set(layer.id, layer);
    }
    return [...unique.values()]
      .filter(include)
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
      .map((layer) => `<${layer.kind}:${layer.id}>\n${layer.content.trim()}`)
      .join("\n\n");
  }

  public list(): PromptPack[] {
    return [...this.packs.values()];
  }
}

function validatePack(pack: PromptPack): void {
  if (!pack.id.trim()) throw new Error("A prompt pack requires an ID.");
  if (pack.layers.length === 0) throw new Error(`Prompt pack '${pack.id}' has no layers.`);
  for (const layer of pack.layers) {
    if (!layer.id.trim() || !layer.content.trim()) throw new Error(`Prompt pack '${pack.id}' contains an empty layer.`);
  }
}
