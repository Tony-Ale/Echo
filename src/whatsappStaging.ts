import { config } from "dotenv";

config({ path: process.env.ECHO_STAGING_ENV_FILE ?? ".env.staging", override: true });

async function main(): Promise<void> {
  if (process.env.ECHO_ENVIRONMENT !== "staging") {
    throw new Error("WhatsApp staging requires ECHO_ENVIRONMENT=staging in .env.staging.");
  }
  const { Container } = await import("./app/container.js");
  const bot = await Container.createBotRuntime();
  await bot.start();
  console.log("Echo WhatsApp staging transport started");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
