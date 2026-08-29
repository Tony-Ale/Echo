import type { DeploymentProfile } from "../../framework/deployments/types.js";

/** Echo remains the default deployment assembled from reusable framework parts. */
export function createEchoDeploymentProfile(models: {
  primary?: string;
  fast?: string;
  transportPluginId?: string;
} = {}): DeploymentProfile {
  const transportPluginId = models.transportPluginId ?? "transport.whatsapp";
  return {
    id: "echo-oha",
    displayName: "Echo",
    transportPluginId,
    pluginIds: ["runtime.agent", transportPluginId, "domain.choir", "deployment.echo"],
    promptPackIds: ["agent-canon-v1", "tool-agent-runtime-v1", "choir-operations-v1", "echo-deployment-v1"],
    models: {
      primary: models.primary ?? "openai/gpt-oss-120b",
      fast: models.fast ?? "llama-3.3-70b-versatile",
    },
    timezone: "Europe/London",
  };
}
