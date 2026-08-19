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
  v: number; alg: string; kdf: string; kid?: string;
  salt: string; wrap_iv: string; dek: string; iv: string; ct: string;
};

/**
 * ANEL DE CHAVES — espelha o que o front passou a fazer.
 *
 * Envelope v2 carrega `kid` (identificador da chave usada). O v1 não tem, e por
 * isso é tentado contra TODAS as chaves do anel.
 *
 * Por que isto existe: antes, trocar a chave mestra tornava ilegível todo
 * envelope já criado — ou seja, um vazamento obrigaria TODOS os clientes a
 * recadastrar certificado. Com o anel, a chave nova cifra o que é novo e a
 * antiga continua abrindo o que já existe, sem incomodar ninguém.
 */
function anel(): Array<{ kid: string; chave: string }> {
  const r: Array<{ kid: string; chave: string }> = [];
  const ativa = process.env["DFE_SECRET_KEY"];
  const anterior = process.env["DFE_SECRET_KEY_PREVIOUS"];
  // O identificador é comparado em minúsculas dos dois lados. No primeiro teste
  // real, o front gravou "K2" e o worker estava com "k2": a credencial existia,
  // a chave era a certa, e mesmo assim não abria. Diferença de caixa em um
  // rótulo não pode custar o acesso do cliente ao dado dele.
  if (ativa) r.push({ kid: (process.env["DFE_SECRET_KEY_ID"] ?? "k1").toLowerCase(), chave: ativa });
  if (anterior) r.push({ kid: (process.env["DFE_SECRET_KEY_PREVIOUS_ID"] ?? "k0").toLowerCase(), chave: anterior });
  if (r.length === 0) {
    throw new Error("DFE_SECRET_KEY não configurada: sem a chave mestra é impossível " +
      "abrir as credenciais cifradas.");
  }
  return r;
}

/**
 * base64 -> bytes. O `slice()` importa: Buffer.from devolve uma view sobre um
 * pool compartilhado, e a Web Crypto exige ArrayBuffer exclusivo. Sem isso o
 * TypeScript recusa e, pior, o runtime poderia ler bytes vizinhos.
 */
const fromB64 = (s: string): ArrayBuffer => {
  const b = Buffer.from(s, "base64");
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

function paraBuffer(k: string): ArrayBuffer {
  const b = new TextEncoder().encode(k);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

async function derivarKek(salt: ArrayBuffer, chave: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", paraBuffer(chave), "HKDF", false, ["deriveKey"]);
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
  if ((env_.v !== 1 && env_.v !== 2) || env_.alg !== "AES-256-GCM") {
    throw new Error(`Envelope em versão/algoritmo não suportado (v=${env_.v}, alg=${env_.alg}).`);
  }

  // v2 diz qual chave usar; v1 não sabe, então tentamos o anel inteiro.
  const kidEnvelope = env_.kid?.toLowerCase();
  const candidatas = kidEnvelope
    ? anel().filter((k) => k.kid === kidEnvelope)
    : anel();

  if (candidatas.length === 0) {
    throw new Error(`A credencial foi cifrada com a chave "${env_.kid}", que não está ` +
      `configurada neste worker. Configure DFE_SECRET_KEY (ou a anterior) correspondente.`);
  }

  let dekRaw: ArrayBuffer | null = null;
  for (const k of candidatas) {
    try {
      dekRaw = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromB64(env_.wrap_iv) },
        await derivarKek(fromB64(env_.salt), k.chave),
        fromB64(env_.dek));
      break;
    } catch { /* tenta a próxima do anel */ }
  }

  if (!dekRaw) {
    throw new Error("Não foi possível abrir a credencial: nenhuma das chaves mestras " +
      "configuradas corresponde à usada no momento do cadastro.");
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

/**
 * Converte o certificado A1 para PEM (chave privada + cadeia de certificados).
 *
 * POR QUE ISTO EXISTE — armadilha real, descoberta no primeiro handshake com a
 * Receita: o Node recusou o arquivo com "Unsupported PKCS12 PFX data", embora o
 * certificado esteja perfeitamente íntegro (o front leu titular, CNPJ e
 * impressão digital sem dificuldade).
 *
 * A causa é o OpenSSL 3, embutido no Node: ele desabilitou por padrão os
 * algoritmos antigos (RC2, 3DES) que os certificados A1 brasileiros usam para
 * proteger o PKCS#12. Não é defeito do certificado nem do Node — é uma decisão
 * de segurança do OpenSSL que colide com o formato que as ACs brasileiras
 * continuam emitindo.
 *
 * A saída é ler o PKCS#12 com uma biblioteca em JavaScript puro (node-forge),
 * que implementa os algoritmos antigos, e entregar ao TLS o material já em PEM.
 * O TLS aceita PEM sem restrição.
 *
 * O material convertido existe apenas em memória, pelo tempo da chamada.
 */
export async function certificadoParaPem(secretRef: string):
  Promise<{ key: string; cert: string }> {
  const forge = (await import("node-forge")).default;
  const { pfx, password } = await abrirCertificado(secretRef);

  let p12;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(Buffer.from(pfx).toString("binary")));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
  } catch (e) {
    throw new Error("Não foi possível abrir o certificado digital. " +
      "Verifique se o arquivo e a senha continuam válidos. " +
      `(detalhe: ${e instanceof Error ? e.message : String(e)})`);
  }

  // Chave privada. Os A1 brasileiros usam pkcs8ShroudedKeyBag; alguns emissores
  // usam keyBag simples, então tentamos os dois.
  const oidShrouded = forge.pki.oids["pkcs8ShroudedKeyBag"] as string;
  const oidKeyBag = forge.pki.oids["keyBag"] as string;
  const oidCert = forge.pki.oids["certBag"] as string;

  const bags: any = p12.getBags({ bagType: oidShrouded });
  const bagsChave: any[] = (bags?.[oidShrouded] as any[])
    ?? ((p12.getBags({ bagType: oidKeyBag }) as any)?.[oidKeyBag] as any[])
    ?? [];
  const chave = bagsChave[0]?.key;
  if (!chave) throw new Error("O certificado não contém chave privada utilizável.");

  // Certificado do titular + cadeia. A Receita pode exigir a cadeia completa,
  // então enviamos todos os certificados presentes no arquivo.
  const bagsCert: any[] = ((p12.getBags({ bagType: oidCert }) as any)?.[oidCert] as any[]) ?? [];
  const certs = bagsCert.map((b: any) => b.cert).filter(Boolean);
  if (certs.length === 0) throw new Error("O certificado não contém nenhum certificado X.509.");

  return {
    key: forge.pki.privateKeyToPem(chave),
    cert: certs.map((c: any) => forge.pki.certificateToPem(c)).join("\n"),
  };
}
