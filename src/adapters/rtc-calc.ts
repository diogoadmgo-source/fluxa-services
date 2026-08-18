import { request } from "undici";
import { env } from "../lib/env.js";

/**
 * Adaptador da CALCULADORA DE TRIBUTOS da Receita Federal.
 *
 * FATO QUE DEFINE ESTE ARQUIVO (Manual Plataforma CBS, RFB, maio/2026):
 * "não há API pública hospedada para cálculo remoto. A integração sistêmica
 *  ocorre por meio do componente offline, executado no ambiente do integrador,
 *  que expõe API local para consumo máquina a máquina."
 *
 * Ou seja: rodar o container NÃO é uma escolha de arquitetura, é o único caminho.
 * O componente é open source, tem banco embarcado, e — importante para vender —
 * "opera fora do ambiente da Administração Tributária, sem realizar coleta de
 *  dados, sem telemetria e sem transmissão automática de informações": o dado
 * fiscal do cliente não sai da nossa infraestrutura.
 *
 * O motor é orientado por matriz de decisão CST × cClassTrib, complementada por
 * objeto da operação, local (UF e município), data do fato gerador e classificação
 * do bem ou serviço (NCM para bens, NBS para serviços). O retorno inclui valores,
 * MEMÓRIA DE CÁLCULO e REFERÊNCIA NORMATIVA — que guardamos em invoice_items.calc_memory
 * para que qualquer número da tela seja rastreável até a base legal.
 *
 * Atualização: a própria Receita entrega alterações de alíquota e parametrização
 * pelo mecanismo de atualização da Calculadora. Nosso papel é fixar a versão em uso
 * (rule_versions.calc_version) e reprocessar conscientemente quando ela mudar.
 *
 * Instalação: imagem Docker, JAR (Java 21) ou WSL. API local em :8080/api, Swagger junto.
 * Docs: https://consumo.tributos.gov.br/servico/calcular-tributos-consumo/calculadora/documentacao
 */

export type CalcInput = {
  cst: string;                 // Código de Situação Tributária
  cclasstrib: string;          // Código de Classificação Tributária
  baseCents: number;
  /** Bens usam NCM; serviços usam NBS. Informe um dos dois. */
  ncm?: string;
  nbs?: string;
  ufOrigem: string;
  ufDestino: string;
  municipioDestino?: string;   // código IBGE — o IBS municipal depende dele
  /** Data do FATO GERADOR, não a data de hoje: a alíquota muda por ano na transição. */
  issuedAt: string;
  objetoOperacao?: "bem" | "servico";
  quantidade?: number;
};

export type CalcOutput = {
  ibsUfCents: number;
  ibsMunCents: number;
  cbsCents: number;
  isCents: number;
  aliquotas: { ibsUf?: number; ibsMun?: number; cbs?: number; is?: number };
  reducaoPct?: number;
  creditEligible: boolean;
  creditCents: number;
  memory: unknown;             // memória de cálculo oficial + base legal
  calcVersion: string;
  /** Soma conveniente: o IBS é dual (estadual + municipal) mas a tela mostra junto. */
  ibsCents: number;
};

const cache = new Map<string, CalcOutput>();
const cacheKey = (i: CalcInput) =>
  [env.RTC_CALC_VERSION, i.cst, i.cclasstrib, i.ncm ?? i.nbs ?? "", i.baseCents,
   i.ufOrigem, i.ufDestino, i.municipioDestino ?? "", i.issuedAt.slice(0, 7)].join("|");

export async function calculate(input: CalcInput): Promise<CalcOutput> {
  const k = cacheKey(input);
  const hit = cache.get(k);
  if (hit) return hit;

  if (!env.RTC_CALC_URL) {
    const out = stubCalculate(input);
    cache.set(k, out);
    return out;
  }

  // Contrato da API local do componente offline. Os nomes seguem a documentação
  // Swagger publicada; se a Receita mudar a versão, este é o único ponto a ajustar.
  const body = {
    dataOperacao: input.issuedAt,
    baseCalculo: input.baseCents / 100,
    cst: input.cst,
    cClassTrib: input.cclasstrib,
    ...(input.ncm ? { ncm: input.ncm } : {}),
    ...(input.nbs ? { nbs: input.nbs } : {}),
    ufOrigem: input.ufOrigem,
    ufDestino: input.ufDestino,
    ...(input.municipioDestino ? { municipioDestino: input.municipioDestino } : {}),
    quantidade: input.quantidade ?? 1,
  };

  const res = await request(`${env.RTC_CALC_URL}/api/calculadora/calcular`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.statusCode >= 300) {
    throw new Error(`Calculadora RTC ${res.statusCode}: ${(await res.body.text()).slice(0, 500)}`);
  }
  const raw = (await res.body.json()) as any;

  const ibsUf = toCents(raw?.tributos?.ibsUf?.valor ?? raw?.ibsUf?.valor ?? 0);
  const ibsMun = toCents(raw?.tributos?.ibsMun?.valor ?? raw?.ibsMun?.valor ?? 0);
  const cbs = toCents(raw?.tributos?.cbs?.valor ?? raw?.cbs?.valor ?? 0);
  const is = toCents(raw?.tributos?.is?.valor ?? raw?.is?.valor ?? 0);

  const out: CalcOutput = {
    ibsUfCents: ibsUf, ibsMunCents: ibsMun, ibsCents: ibsUf + ibsMun,
    cbsCents: cbs, isCents: is,
    aliquotas: {
      ibsUf: raw?.tributos?.ibsUf?.aliquota, ibsMun: raw?.tributos?.ibsMun?.aliquota,
      cbs: raw?.tributos?.cbs?.aliquota, is: raw?.tributos?.is?.aliquota,
    },
    reducaoPct: raw?.reducao?.percentual,
    // Crédito na entrada segue o efeito do cClassTrib; a própria calculadora
    // orienta sobre manutenção ou estorno do crédito da etapa anterior.
    creditEligible: raw?.credito?.permiteApropriacao ?? true,
    creditCents: toCents(raw?.credito?.valor ?? (ibsUf + ibsMun + cbs) / 100),
    memory: raw?.memoriaCalculo ?? raw,
    calcVersion: raw?.versao ?? env.RTC_CALC_VERSION,
  };
  cache.set(k, out);
  return out;
}

/**
 * Valida um XML com o ASSISTENTE VALIDADOR oficial — "verifica um arquivo XML à
 * luz das regras aplicáveis, identificando inconsistências antes do envio para
 * autorização". É a resposta certa para a dor de nota rejeitada: em vez de
 * reimplementarmos as regras da SEFAZ (e errarmos), usamos o validador da Receita.
 */
export async function validateXml(xml: string): Promise<{ valido: boolean; inconsistencias: unknown[] }> {
  if (!env.RTC_CALC_URL) throw new Error("validateXml exige RTC_CALC_URL (componente offline)");
  const res = await request(`${env.RTC_CALC_URL}/api/assistente/validar`, {
    method: "POST",
    headers: { "content-type": "application/xml" },
    body: xml,
  });
  const raw = (await res.body.json()) as any;
  return {
    valido: res.statusCode < 300 && (raw?.valido ?? raw?.inconsistencias?.length === 0),
    inconsistencias: raw?.inconsistencias ?? [],
  };
}

/** Dados abertos do componente: matriz CST × cClassTrib com efeitos tributários. */
export async function fetchClassTribMatrix(): Promise<unknown[]> {
  if (!env.RTC_CALC_URL) throw new Error("fetchClassTribMatrix exige RTC_CALC_URL");
  const res = await request(`${env.RTC_CALC_URL}/api/dados-abertos/class-trib`);
  if (res.statusCode >= 300) throw new Error(`dados abertos ${res.statusCode}`);
  const raw = (await res.body.json()) as any;
  return Array.isArray(raw) ? raw : (raw?.conteudo ?? []);
}

const toCents = (v: unknown) => Math.round(Number(v ?? 0) * 100);

/**
 * MODO DEGRADADO — só para desenvolvimento sem o container.
 * PROIBIDO EM PRODUÇÃO: alíquota fixa, sem base legal, sem memória de cálculo.
 * Existe para o time conseguir rodar a aplicação, não para produzir número que
 * alguém vá usar numa decisão.
 */
function stubCalculate(input: CalcInput): CalcOutput {
  const rate = 0.18;
  const ibsUf = Math.round(input.baseCents * rate * 0.35);
  const ibsMun = Math.round(input.baseCents * rate * 0.14);
  const cbs = Math.round(input.baseCents * rate * 0.51);
  return {
    ibsUfCents: ibsUf, ibsMunCents: ibsMun, ibsCents: ibsUf + ibsMun,
    cbsCents: cbs, isCents: 0,
    aliquotas: {}, creditEligible: true, creditCents: ibsUf + ibsMun + cbs,
    memory: { modo: "STUB — sem RTC_CALC_URL. NÃO USAR EM PRODUÇÃO", rate },
    calcVersion: `stub-${env.RTC_CALC_VERSION}`,
  };
}
