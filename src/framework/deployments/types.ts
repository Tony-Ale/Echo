export interface DeploymentProfile {
  id: string;
  displayName: string;
  transportPluginId: string;
  pluginIds: string[];
  promptPackIds: string[];
  models: {
    primary: string;
    fast: string;
  };
  timezone: string;
}

export function validateDeploymentProfile(profile: DeploymentProfile): void {
  if (!profile.id.trim()) throw new Error("A deployment profile requires an ID.");
  if (!profile.pluginIds.includes(profile.transportPluginId)) {
    throw new Error(`Deployment '${profile.id}' does not include its transport plugin.`);
  }
  if (new Set(profile.pluginIds).size !== profile.pluginIds.length) {
    throw new Error(`Deployment '${profile.id}' contains duplicate plugin IDs.`);
  }
  if (profile.promptPackIds.length === 0) throw new Error(`Deployment '${profile.id}' requires a prompt pack.`);
}

