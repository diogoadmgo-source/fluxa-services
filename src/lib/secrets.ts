/**
 * Abertura dos segredos cifrados guardados no bucket privado.
 *
 * Este módulo é o ESPELHO EXATO de sealSecret() em src/lib/credentials.server.ts
 * do front. As duas pontas precisam falar o mesmo formato; se divergirem, o erro
 * só aparece na primeira leitura real, com credencial de cliente. Por isso o
 * formato está documentado aqui e lá, e qualquer mudança tem que ser feita nos
 * dois lugares ao mesmo tempo.
 *
 * ENVELOPE (JSON, UTF-8):
 *   { v:1, alg:"AES-256-GCM", kdf:"HKDF-SHA-256",
 *     salt, wrap_iv, dek, iv, ct }   — todos em base64
 *
 * Abertura:
 *   1. KEK = HKDF-SHA-256(DFE_SECRET_KEY, salt, info="techiva:dfe-credential:v1")
 *   2. DEK = AES-256-GCM.decrypt(KEK, wrap_iv, dek)
 *   3. material = AES-256-GCM.decrypt(DEK, iv, ct)
 *
 * O material aberto existe só em memória, pelo tempo da chamada. Nunca é
 * gravado em disco, nunca vai para log, nunca é devolvido em resposta.
 */
/**
 * Nota de desenho: `abrirEnvelope` é criptografia pura e NÃO depende de banco.
 * A conexão só é carregada dentro de `abrirSegredo`, sob demanda. Sem isso,
 * importar este módulo exigiria variáveis de ambiente do Supabase — e um teste
 * de cifra passaria a depender de infraestrutura, o que é errado e foi
 * justamente o que o primeiro teste apontou.
 */

const SECRETS_BUCKET = "dfe-secrets";
const INFO = (() => {
  const b = new TextEncoder().encode("techiva:dfe-credential:v1");
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
})();

type Envelope = {
  v: number; alg: string; kdf: string;
  salt: string; wrap_iv: string; dek: string; iv: string; ct: string;
};

/**
 * base64 -> bytes. O `slice()` importa: Buffer.from devolve uma view sobre um
 * pool compartilhado, e a Web Crypto exige ArrayBuffer exclusivo. Sem isso o
 * TypeScript recusa e, pior, o runtime poderia ler bytes vizinhos.
 */
const fromB64 = (s: string): ArrayBuffer => {
  const b = Buffer.from(s, "base64");
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

function chaveMestra(): ArrayBuffer {
  const k = process.env["DFE_SECRET_KEY"];
  if (!k) {
    throw new Error("DFE_SECRET_KEY não configurada: sem a chave mestra é impossível " +
      "abrir as credenciais cifradas. Ela deve ser a MESMA usada pelo front ao cifrar.");
  }
  const b = new TextEncoder().encode(k);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

async function derivarKek(salt: ArrayBuffer): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", chaveMestra(), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: INFO },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
}

/** Abre o envelope e devolve o material em texto. */
export async function abrirEnvelope(bytes: Uint8Array): Promise<string> {
  let env_: Envelope;
  try {
    env_ = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("O objeto no cofre não está no formato de envelope esperado.");
  }
  if (env_.v !== 1 || env_.alg !== "AES-256-GCM") {
    throw new Error(`Envelope em versão/algoritmo não suportado (v=${env_.v}, alg=${env_.alg}).`);
  }

  const kek = await derivarKek(fromB64(env_.salt));

  let dekRaw: ArrayBuffer;
  try {
    dekRaw = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(env_.wrap_iv) }, kek, fromB64(env_.dek));
  } catch {
    // Falha aqui quase sempre significa chave mestra diferente da usada ao cifrar.
    throw new Error("Não foi possível abrir a credencial: a chave mestra do worker " +
      "não corresponde à usada no momento do cadastro.");
  }

  const dek = await crypto.subtle.importKey("raw", dekRaw, { name: "AES-GCM" }, false, ["decrypt"]);
  const claro = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(env_.iv) }, dek, fromB64(env_.ct));

  return new TextDecoder().decode(claro);
}

/** Busca o objeto no bucket privado e abre. */
export async function abrirSegredo(secretRef: string): Promise<string> {
  const { createClient } = await import("@supabase/supabase-js");
  const { env } = await import("./env.js");
  const storage = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const { data, error } = await storage.storage.from(SECRETS_BUCKET).download(secretRef);
  if (error || !data) {
    throw new Error(`Credencial não encontrada no cofre (${secretRef}). ` +
      `Se ela foi revogada, cadastre novamente.`);
  }
  const bytes = new Uint8Array(await data.arrayBuffer());
  return abrirEnvelope(bytes);
}

/** Certificado A1: o envelope guarda { v, pfx (base64), password }. */
export async function abrirCertificado(secretRef: string):
  Promise<{ pfx: Uint8Array; password: string }> {
  const bundle = JSON.parse(await abrirSegredo(secretRef));
  if (!bundle?.pfx || typeof bundle.password !== "string") {
    throw new Error("Envelope do certificado incompleto.");
  }
  return { pfx: new Uint8Array(fromB64(bundle.pfx)), password: bundle.password };
}
