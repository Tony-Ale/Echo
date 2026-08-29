import type { ActivatedPlugins, AgentPlugin } from "./types.js";

/** Static, typed plugin registry with dependency ordering and duplicate checks. */
export class PluginRegistry<TTool = unknown> {
  private readonly plugins = new Map<string, AgentPlugin<TTool>>();

  public register(plugin: AgentPlugin<TTool>): void {
    const id = plugin.manifest.id.trim();
    if (!id) throw new Error("A plugin requires an ID.");
    if (this.plugins.has(id)) throw new Error(`Plugin '${id}' is already registered.`);
    this.plugins.set(id, plugin);
  }

  public async activate(requestedIds: string[]): Promise<ActivatedPlugins<TTool>> {
    const ordered = this.resolveDependencies(requestedIds);
    for (const plugin of ordered) await plugin.initialize?.();
    return {
      plugins: ordered,
      tools: ordered.flatMap((plugin) => plugin.tools ?? []),
      promptPacks: ordered.flatMap((plugin) => plugin.promptPacks ?? []),
    };
  }

  private resolveDependencies(requestedIds: string[]): AgentPlugin<TTool>[] {
    const result: AgentPlugin<TTool>[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();

    const visit = (id: string): void => {
      if (visited.has(id)) return;
      if (visiting.has(id)) throw new Error(`Plugin dependency cycle detected at '${id}'.`);
      const plugin = this.plugins.get(id);
      if (!plugin) throw new Error(`Plugin '${id}' is not registered.`);
      visiting.add(id);
      for (const dependency of plugin.manifest.dependencies ?? []) visit(dependency);
      visiting.delete(id);
      visited.add(id);
      result.push(plugin);
    };

    for (const id of requestedIds) visit(id);
    return result;
  }
}
