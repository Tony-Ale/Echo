export type PromptLayerKind = "canon" | "runtime" | "domain" | "deployment" | "task";

export interface PromptLayer {
  id: string;
  kind: PromptLayerKind;
  content: string;
  order: number;
}

export interface PromptPack {
  id: string;
  description: string;
  layers: PromptLayer[];
}

