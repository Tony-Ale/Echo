import type { PromptPack } from "../prompts/types.js";

export type PluginKind = "runtime" | "domain" | "integration" | "deployment";

export interface PluginManifest {
  id: string;
  version: string;
  kind: PluginKind;
  description: string;
  dependencies?: string[];
}

export interface AgentPlugin<TTool = unknown> {
  manifest: PluginManifest;
  tools?: TTool[];
  promptPacks?: PromptPack[];
  initialize?(): Promise<void>;
  shutdown?(): Promise<void>;
}

export interface ActivatedPlugins<TTool = unknown> {
  plugins: AgentPlugin<TTool>[];
  tools: TTool[];
  promptPacks: PromptPack[];
}
