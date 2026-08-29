import { Container } from "./app/container.js";
import type { WhatsAppBot } from "./integrations/whatsapp/whatsappBot.js";
import express from "express";

const app = express();
let bot: WhatsAppBot | undefined;

app.get("/health/live", (_, res) => {
  res.status(200).json({ status: "live" });
});

const readinessHandler: express.RequestHandler = (_, res) => {
  const ready = bot?.isReady() === true;
  res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready" });
};
app.get("/", readinessHandler);
app.get("/health/ready", readinessHandler);

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`Health server running on ${PORT}`);
});


async function main(): Promise<void> {
  try {
    bot = await Container.createBotRuntime();
    await bot.start();
    console.log("Echo agent initialized; waiting for WhatsApp readiness");
  } catch (error) {
    console.error("Failed to start Echo agent", error);
    server.close(() => {
      process.exitCode = 1;
    });
  }
}

void main();

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down Echo`);
    bot?.stop();
    const forceExit = setTimeout(() => process.exit(1), 10_000);
    forceExit.unref();
    server.close(() => {
      clearTimeout(forceExit);
      process.exit(0);
    });
  });
}
