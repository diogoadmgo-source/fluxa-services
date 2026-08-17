import pino from "pino";
import { env } from "./env.js";

export const log = pino({ level: env.LOG_LEVEL, base: { worker: env.WORKER_NAME } });

/** Todo log de worker carrega tenant_id e job_id — sem isso não se depura fila multi-tenant. */
export const jobLog = (jobId: string, tenantId: string, kind: string) =>
  log.child({ job_id: jobId, tenant_id: tenantId, kind });
