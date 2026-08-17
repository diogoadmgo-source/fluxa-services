/**
 * Execução avulsa, para desenvolvimento:
 *   npm run run:once -- project_cash <tenant_id>
 */
import { db } from "./lib/supabase.js";
import { log } from "./lib/log.js";

const [kind, tenant] = process.argv.slice(2);
if (!kind || !tenant) {
  console.error("uso: npm run run:once -- <kind> <tenant_id>");
  process.exit(1);
}
const { data, error } = await db.from("jobs")
  .insert({ tenant_id: tenant, kind, params: {} }).select("id").single();
if (error) { log.error({ error }, "falha ao enfileirar"); process.exit(1); }
log.info({ job_id: data.id }, "job enfileirado — um worker vai pegá-lo");
