import { env, workerKinds } from "./lib/env.js";
import { log, jobLog } from "./lib/log.js";
import { claimJob, finish, fail, type Job } from "./lib/jobs.js";
import { ingestDfe } from "./workers/ingest-dfe.js";
import { classifyChain } from "./workers/classify-chain.js";
import { computeTaxes } from "./workers/compute-taxes.js";
import { projectCash } from "./workers/project-cash.js";
import { fetchApuracao } from "./workers/fetch-apuracao.js";
import { auditMerit } from "./workers/audit-merit.js";

const handlers: Record<string, (job: Job) => Promise<Record<string, unknown>>> = {
  ingest_dfe: ingestDfe,
  classify_chain: classifyChain,
  compute_taxes: computeTaxes,
  project_cash: projectCash,
  fetch_apuracao: fetchApuracao,
  audit_merit: auditMerit,
};

let running = true;
process.on("SIGTERM", () => { log.info("SIGTERM: encerrando após o job atual"); running = false; });
process.on("SIGINT", () => { running = false; });

async function loop() {
  log.info({ kinds: workerKinds }, "worker iniciado");
  while (running) {
    let job: Job | null = null;
    try {
      job = await claimJob(workerKinds);
    } catch (err) {
      log.error({ err }, "falha ao reivindicar job");
    }

    if (!job) { await sleep(env.POLL_INTERVAL_MS); continue; }

    const l = jobLog(job.id, job.tenant_id, job.kind);
    const started = Date.now();
    try {
      const handler = handlers[job.kind];
      if (!handler) throw new Error(`sem handler para ${job.kind}`);
      const result = await handler(job);
      await finish(job.id, result);
      l.info({ ms: Date.now() - started, result }, "job concluído");
    } catch (err) {
      // O banco decide reenfileirar (backoff) ou marcar como falha definitiva.
      await fail(job.id, err).catch((e) => l.error({ e }, "falha ao reportar erro"));
      l.error({ err, ms: Date.now() - started, attempts: job.attempts }, "job falhou");
    }
  }
  log.info("worker encerrado");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
loop().catch((err) => { log.fatal({ err }, "loop morreu"); process.exit(1); });
