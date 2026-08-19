import { request, Agent } from "undici";
import { env } from "../lib/env.js";
import { certificadoParaPem } from "../lib/secrets.js";

/**
 * Adaptador da API de Apuração Assistida da CBS (Receita Federal).
 *
 * Fluxo oficial em três passos — e o segundo é assíncrono, o que define todo o
 * desenho: a Receita NÃO devolve o tíquete na resposta; ela CHAMA nosso webhook
 * depois, entregando { tiqueteSolicitacao, tiqueteDownload }.
 *
 *   1. POST {tokenUrl}                       -> token (vale 1 hora)
 *   2. POST {base}{prefix}/apuracao-cbs/v1/{cnpj8}  body {"urlRetorno": ...}
 *      -> 201 com tíquete de solicitação; o de DOWNLOAD vem pelo webhook
 *   3. GET  {base}{prefix}/download/v1/{tiqueteDownload} -> JSON do extrato
 *
 * LIMITES QUE NÃO PODEM SER VIOLADOS (documentação oficial):
 *   - 2 solicitações por dia POR CNPJ. Estourar devolve 429 e o cliente fica sem
 *     dado até o dia seguinte. Por isso a cota é debitada NO BANCO antes da
 *     chamada — a decisão de deixar ou não passar não é deste código.
 *   - 8 downloads por dia, e UM ÚNICO ACESSO POR TÍQUETE. Repetir um tíquete já
 *     consumido queima uma chamada e não traz nada. O tíquete é apagado do banco
 *     assim que o download tem sucesso.
 *   - O arquivo fica disponível por 24 horas.
 */

export type TokenResposta = { access_token: string; expires_in?: number };

/**
 * As APIs da Receita usam autenticação MÚTUA (mTLS): além do token, o cliente
 * apresenta o certificado digital no próprio handshake TLS. Sem isso, a conexão
 * é recusada — e o sintoma costuma ser confuso, porque parece erro de rede e não
 * de credencial.
 *
 * O certificado é o MESMO A1 da empresa que já guardamos cifrado para a
 * ingestão de DF-e. Passa-se o par (pfx, senha) para o agente de conexão; o
 * material existe apenas em memória, pelo tempo da chamada.
 *
 * Quando `secretRefCertificado` não é informado, a conexão vai sem certificado —
 * útil para ambientes que não exigem, e para não travar quem ainda não subiu o A1.
 */
async function agente(secretRefCertificado?: string | null): Promise<Agent | undefined> {
  if (!secretRefCertificado) return undefined;
  // PEM, não PKCS#12: o OpenSSL do Node recusa os algoritmos antigos usados nos
  // certificados A1 brasileiros. A conversão acontece em certificadoParaPem.
  const { key, cert } = await certificadoParaPem(secretRefCertificado);
  return new Agent({
    connect: {
      key, cert,
      // TLS 1.2 é o mínimo exigido pela documentação da Receita.
      minVersion: "TLSv1.2",
    },
    connectTimeout: 20_000,   // o gateway da Receita costuma ser lento no primeiro aperto de mão
  });
}

/** Passo 1 — autenticar com ClientId/ClientSecret do contribuinte. */
export async function obterToken(clientId: string, clientSecret: string,
                                 secretRefCertificado?: string | null): Promise<string> {
  const disp = await agente(secretRefCertificado);
  const res = await request(env.RTC_API_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      // padrão OAuth2 client_credentials com credencial no header
      authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
    ...(disp ? { dispatcher: disp } : {}),
  });

  if (res.statusCode >= 300) {
    throw new Error(`Falha ao autenticar na Receita (${res.statusCode}). ` +
      `Verifique se o ClientId e o ClientSecret continuam válidos no Portal RTC.`);
  }
  const body = (await res.body.json()) as TokenResposta;
  if (!body?.access_token) throw new Error("A Receita não devolveu token de acesso.");
  return body.access_token;
}

/**
 * Passo 2 — solicitar a apuração. Devolve o tíquete de SOLICITAÇÃO; o de
 * download chega depois, no webhook.
 * ATENÇÃO: o CNPJ vai com 8 dígitos (CNPJ base), não os 14.
 */
export async function solicitarApuracao(
  token: string, cnpj8: string, urlRetorno: string, secretRefCertificado?: string | null,
): Promise<{ tiquete?: string }> {
  const disp = await agente(secretRefCertificado);
  const url = `${env.RTC_API_BASE}${env.RTC_API_PREFIX}/apuracao-cbs/v1/${cnpj8}`;
  const res = await request(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ urlRetorno }),
    ...(disp ? { dispatcher: disp } : {}),
  });

  const texto = await res.body.text();
  if (res.statusCode === 201) {
    const b = safeJson(texto);
    return { tiquete: b?.tiquete ?? b?.tiqueteSolicitacao };
  }
  if (res.statusCode === 429) {
    throw new Error("A Receita recusou por excesso de chamadas (2 por dia por CNPJ). " +
      "A cota reinicia amanhã.");
  }
  const b = safeJson(texto);
  throw new Error(`Solicitação recusada (${res.statusCode})` +
    (b?.mensagemErro ? `: ${b.mensagemErro}` : "") + (b?.codigoErro ? ` [${b.codigoErro}]` : ""));
}

/**
 * Passo 3 — baixar o extrato. Um único acesso por tíquete.
 * O 403 tem significado específico e merece mensagem própria: quer dizer que a
 * credencial usada é de OUTRO CNPJ que não o da solicitação — erro de
 * configuração, não de rede, e repetir não resolve.
 */
export async function baixarApuracao(token: string, tiqueteDownload: string,
                                     secretRefCertificado?: string | null): Promise<unknown> {
  const disp = await agente(secretRefCertificado);
  const url = `${env.RTC_API_BASE}${env.RTC_API_PREFIX}/download/v1/${tiqueteDownload}`;
  const res = await request(url, {
    method: "GET",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    ...(disp ? { dispatcher: disp } : {}),
  });

  if (res.statusCode === 200) return await res.body.json();

  const texto = await res.body.text();
  if (res.statusCode === 403) {
    throw new Error("A Receita recusou o download: o CNPJ da credencial não corresponde " +
      "ao CNPJ da solicitação. Verifique se a credencial cadastrada é mesmo desta empresa.");
  }
  if (res.statusCode === 404) {
    throw new Error("Arquivo não encontrado ou tíquete inválido. O arquivo expira em 24 horas " +
      "e cada tíquete permite um único download.");
  }
  throw new Error(`Download recusado (${res.statusCode}): ${texto.slice(0, 300)}`);
}

const safeJson = (t: string): any => { try { return JSON.parse(t); } catch { return null; } };
