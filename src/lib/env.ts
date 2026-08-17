import { z } from "zod";

const schema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  RTC_CALC_URL: z.string().url().optional(),
  RTC_CALC_VERSION: z.string().default("dev"),
  CNPJ_API_URL: z.string().optional(),
  CNPJ_API_KEY: z.string().optional(),
  WORKER_NAME: z.string().default("worker-1"),
  WORKER_KINDS: z.string().default("ingest_dfe,classify_chain,compute_taxes,project_cash"),
  POLL_INTERVAL_MS: z.coerce.number().default(3000),
  LEASE_SECONDS: z.coerce.number().default(300),
  LOG_LEVEL: z.string().default("info"),
});

export const env = schema.parse(process.env);
export const workerKinds = env.WORKER_KINDS.split(",").map((s) => s.trim()).filter(Boolean);
