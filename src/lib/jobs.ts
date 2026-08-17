import { db } from "./supabase.js";
import { env } from "./env.js";

export type Job = {
  id: string;
  tenant_id: string;
  kind: string;
  params: Record<string, unknown>;
  attempts: number;
};

/**
 * Reivindica um job da fila. O banco garante um job por tenant+kind (FOR UPDATE SKIP LOCKED).
 * claim_job devolve um CONJUNTO: vazio significa que não há trabalho.
 */
export async function claimJob(kinds: string[]): Promise<Job | null> {
  const { data, error } = await db.rpc("claim_job", {
    p_kinds: kinds,
    p_worker: env.WORKER_NAME,
    p_lease_seconds: env.LEASE_SECONDS,
  });
  if (error) throw error;
  const rows = (data ?? []) as Job[];
  const job = rows[0];
  return job && job.id ? job : null;
}

export async function progress(jobId: string, pct: number, message?: string) {
  const { error } = await db.rpc("report_job", {
    p_job: jobId,
    p_status: "running",
    p_progress: Math.max(0, Math.min(100, pct)),
    p_message: message ?? null,
    p_lease_seconds: env.LEASE_SECONDS,
  });
  if (error) throw error;
}

export async function finish(jobId: string, result: Record<string, unknown>) {
  const { error } = await db.rpc("report_job", {
    p_job: jobId, p_status: "done", p_progress: 100, p_result: result,
  });
  if (error) throw error;
}

/** Falha com backoff: o banco reenfileira até 5 tentativas e só então cria alerta. */
export async function fail(jobId: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const { error } = await db.rpc("report_job", {
    p_job: jobId, p_status: "failed", p_error: message.slice(0, 2000),
  });
  if (error) throw error;
}

/** Encadeia o próximo passo do pipeline: ingest -> classify -> taxes -> cash. */
export async function enqueue(tenantId: string, kind: string, params: Record<string, unknown> = {}) {
  const { error } = await db.from("jobs").insert({ tenant_id: tenantId, kind, params });
  if (error) throw error;
}
