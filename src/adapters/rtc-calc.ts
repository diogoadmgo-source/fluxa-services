import { request } from "undici";
import { env } from "../lib/env.js";

/**
 * Adaptador da Calculadora RTC (componente offline da Receita, rodando em container
 * próprio na rede interna). O front NUNCA fala com ela; só este serviço.
 *
 * Cache por (versão da regra + chave fiscal do item): a mesma combinação de NCM,
 * CST, cClassTrib, origem/destino e valor sempre devolve o mesmo resultado dentro
 * de uma versão — sem cache, uma ingestão de 50 mil itens vira 50 mil chamadas.
 */
export type CalcInput = {
  ncm: string; cst: string; cclasstrib: string;
  baseCents: number;
  ufOrigem: string; ufDestino: string; municipioDestino?: string;
  issuedAt: string; // ISO date — a alíquota muda por ano na transição
};

export type CalcOutput = {
  ibsCents: number; cbsCents: number; isCents: number;
  creditEligible: boolean; creditCents: number;
  memory: unknown;         // memória de cálculo oficial, guardada em invoice_items.calc_memory
  calcVersion: string;
};

const cache = new Map<string, CalcOutput>();
const key = (i: CalcInput) =>
  [env.RTC_CALC_VERSION, i.ncm, i.cst, i.cclasstrib, i.baseCents, i.ufOrigem, i.ufDestino,
   i.municipioDestino ?? "", i.issuedAt.slice(0, 4)].join("|");

export async function calculate(input: CalcInput): Promise<CalcOutput> {
  const k = key(input);
  const hit = cache.get(k);
  if (hit) return hit;

  if (!env.RTC_CALC_URL) {
    // Modo degradado para dev sem o container da Receita.
    // NUNCA deve rodar em produção: os valores são aproximados e não têm base legal.
    const rate = 0.18;
    const out: CalcOutput = {
      ibsCents: Math.round(input.baseCents * rate * 0.489),
      cbsCents: Math.round(input.baseCents * rate * 0.511),
      isCents: 0,
      creditEligible: true,
      creditCents: Math.round(input.baseCents * rate),
      memory: { mode: "STUB — sem RTC_CALC_URL", rate },
      calcVersion: `stub-${env.RTC_CALC_VERSION}`,
    };
    cache.set(k, out);
    return out;
  }

  const res = await request(`${env.RTC_CALC_URL}/v1/calcular`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.statusCode >= 300) {
    throw new Error(`RTC calc ${res.statusCode}: ${await res.body.text()}`);
  }
  const out = (await res.body.json()) as CalcOutput;
  cache.set(k, out);
  return out;
}
