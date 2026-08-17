import { createClient } from "@supabase/supabase-js";
import { env } from "./env.js";

/**
 * Cliente com service_role: ignora RLS por definição.
 * Regra do projeto: esta chave NUNCA sai do servidor, e toda query feita por aqui
 * carrega tenant_id explícito — a proteção do banco some, a disciplina não pode sumir.
 */
export const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
