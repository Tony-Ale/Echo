import { config } from "dotenv";

config({ path: process.env.ECHO_STAGING_ENV_FILE ?? ".env.staging", override: true });

async function main(): Promise<void> {
  if (process.env.ECHO_ENVIRONMENT !== "staging") {
    throw new Error("Local chat requires ECHO_ENVIRONMENT=staging in .env.staging.");
  }
  const { startLocalChatServer } = await import("./integrations/localChat/localChatServer.js");
  await startLocalChatServer({
    port: Number(process.env.LOCAL_CHAT_PORT ?? "3100"),
    conversationId: process.env.LOCAL_CHAT_CONVERSATION_ID ?? "echo-local-staging",
  });
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
