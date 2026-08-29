import { config as loadEnv } from "dotenv";
import { z } from "zod";

// The staging entrypoint loads its dedicated file before importing the app.
// Do not backfill missing staging values from a developer's production .env.
if (process.env.ECHO_ENVIRONMENT !== "staging") loadEnv();

const booleanEnvironmentValue = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
  PINECONE_API_KEY: z.string().min(1),
  PINECONE_INDEX_NAME: z.string().min(1),
  AI_MODEL_CONFIG_PATH: z.string().min(1).default("config/models.yaml"),
  AGENT_CONFIG_PATH: z.string().min(1).default("config/agent.yaml"),
  GOOGLE_SERVICE_ACCOUNT_KEY_PATH: z.string().min(1),
  GOOGLE_SPREADSHEET_ID: z.string().min(1),
  WHATSAPP_SESSION_ID: z.string().min(1).default("oha-bot-session-id"),
  WHATSAPP_GROUP_ID: z.string().min(1),
  WHATSAPP_ALLOW_ALL_GROUPS: booleanEnvironmentValue,
  WHATSAPP_LOG_GROUP_IDS: booleanEnvironmentValue,
  TOP_K: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 8)),
  SUPABASE_URL: z.string().min(1),
  SUPABASE_KEY: z.string().min(1),
  ECHO_BOOTSTRAP_CREATOR_PHONE: z.string().optional(),
  ECHO_ENVIRONMENT: z.enum(["development", "staging", "production"]).default("development"),
});

/**
 * Strictly validated runtime environment configuration.
 */
export const env = envSchema.parse({
  ...process.env,
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY:
    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, "\n")
});
