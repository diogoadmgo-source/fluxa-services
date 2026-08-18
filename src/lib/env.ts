import { z } from "zod";

const schema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  RTC_CALC_URL: z.string().url().optional(),
  RTC_CALC_VERSION: z.string().default("dev"),
  CNPJ_API_URL: z.string().optional(),
  CNPJ_API_KEY: z.string().optional(),

  /**
   * API da Receita (apuração assistida da CBS).
   * Três ambientes possíveis, conforme a documentação oficial:
   *   produção          https://api.receitafederal.gov.br
   *   produção restrita https://api.receitafederal.gov.br/prr-rtc  (prefixo diferente!)
   *   homologação       https://h-gateway.receitaintegra.serpro.gov.br
   * O prefixo de produção restrita muda o CAMINHO, não só o host — por isso as
   * rotas são configuráveis em vez de montadas por concatenação ingênua.
   */
  RTC_API_TOKEN_URL: z.string().url().default("https://api.receitafederal.gov.br/token"),
  RTC_API_BASE: z.string().url().default("https://api.receitafederal.gov.br"),
  RTC_API_PREFIX: z.string().default("/rtc"),
  /** Endereço público do webhook. Sem ele não há como solicitar apuração. */
  RTC_WEBHOOK_BASE: z.string().url().optional(),
  WORKER_NAME: z.string().default("worker-1"),
  WORKER_KINDS: z.string().default("ingest_dfe,classify_chain,compute_taxes,project_cash,fetch_apuracao"),
  POLL_INTERVAL_MS: z.coerce.number().default(3000),
  LEASE_SECONDS: z.coerce.number().default(300),
  LOG_LEVEL: z.string().default("info"),
});

export const env = schema.parse(process.env);
export const workerKinds = env.WORKER_KINDS.split(",").map((s) => s.trim()).filter(Boolean);
