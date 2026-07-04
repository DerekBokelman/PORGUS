import "dotenv/config";
import * as z from "zod";

const envSchema = z
  .object({
    DATABASE_PATH: z.string().default("data/agent-company.db"),
    LIVING_SPEND_CEILING_USD: z.coerce.number().positive().default(5),
    LIVING_MAX_HEADCOUNT: z.coerce.number().int().positive().default(10),
    LIVING_HEARTBEAT: z
      .string()
      .default("true")
      .transform((value) => value.toLowerCase() !== "false" && value !== "0"),
    // Delay between work cycles while agents are actively working.
    LIVING_TICK_MIN_MS: z.coerce.number().int().positive().default(5000),
    // Backoff ceiling: delay between cycles once agents go idle (budget/rate-limited).
    LIVING_TICK_MS: z.coerce.number().int().positive().default(180000)
  });

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig() {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("\n");

    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return {
    databasePath: parsed.data.DATABASE_PATH,
    livingSpendCeilingUsd: parsed.data.LIVING_SPEND_CEILING_USD,
    livingMaxHeadcount: parsed.data.LIVING_MAX_HEADCOUNT,
    livingHeartbeatEnabled: parsed.data.LIVING_HEARTBEAT,
    livingTickBusyMs: parsed.data.LIVING_TICK_MIN_MS,
    livingTickIdleMs: parsed.data.LIVING_TICK_MS
  };
}
