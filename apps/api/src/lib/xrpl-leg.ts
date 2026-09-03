/**
 * Pierna XRPL del atomic swap — sustituye a ATOMIC_SWAP_CONTRACT_B.
 *
 * Hasta M4.5 la "cadena B" era una segunda instancia del mismo contrato de
 * Soroban: dos piernas en la misma cadena, o sea un swap cross-chain que no
 * cruzaba nada. Aquí la pierna B pasa a ser un escrow nativo de XRPL.
 *
 * No hay contrato que desplegar: XRPL trae el patrón hashlock/timelock en el
 * ledger (`EscrowCreate` con `Condition` PREIMAGE-SHA-256 + `CancelAfter`).
 * Lo único que hace falta es traducir dos lenguajes, y de eso se encarga
 * `@micopaybridge/xrpl-bridge`, que ya está validado byte a byte contra
 * five-bells-condition. Aquí no se re-implementa nada de eso (R-4 del plan).
 *
 * La regla que no se negocia: la `Condition` de XRPL sale de la MISMA
 * preimagen que el `secret_hash` de Soroban. Si se generaran por separado no
 * habría swap atómico, sino dos escrows sin relación.
 */

import { Client, Wallet, xrpToDrops, type EscrowCreate, type EscrowFinish, type EscrowCancel } from "xrpl";
import * as bt from "@micopaybridge/xrpl-bridge/bridge-translate";

export const XRPL_SERVER = process.env.XRPL_SERVER ?? "wss://s.altnet.rippletest.net:51233";

export interface XrplLegResult {
  hash: string;
  /** Sequence del EscrowCreate: junto con el owner identifica el escrow. */
  offerSequence: number;
  owner: string;
  destination: string;
  condition: string;
  cancelAfter: number;
}

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client(XRPL_SERVER);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.disconnect();
  }
}

function requireSuccess(result: string, what: string): void {
  if (result !== "tesSUCCESS") throw new Error(`XRPL ${what} falló: ${result}`);
}

/**
 * La contraparte bloquea XRP contra el hash del secreto que ya está en
 * Soroban. Recibe el HASH, no la preimagen: quien bloquea la pierna B nunca
 * conoce el secreto — de eso vive el HTLC.
 */
export async function lockXrplLeg(params: {
  counterpartySeed: string;
  destinationAddress: string;
  amountXrp: string;
  secretHash: Buffer;
  cancelAfterUnix: number;
}): Promise<XrplLegResult> {
  const wallet = Wallet.fromSeed(params.counterpartySeed);
  const condition = bt.xrplConditionFromHash(params.secretHash);
  const cancelAfter = bt.toRippleTime(params.cancelAfterUnix);

  return withClient(async (client) => {
    const tx: EscrowCreate = {
      TransactionType: "EscrowCreate",
      Account: wallet.address,
      // Toda tx que emitimos lleva el source tag del reto Make Waves: el
      // leaderboard solo cuenta lo etiquetado, y no se puede reetiquetar después.
      SourceTag: bt.SOURCE_TAG,
      Destination: params.destinationAddress,
      Amount: xrpToDrops(params.amountXrp),
      Condition: condition,
      CancelAfter: cancelAfter,
    };
    const res = await client.submitAndWait(tx, { autofill: true, wallet });
    requireSuccess((res.result.meta as { TransactionResult: string }).TransactionResult, "EscrowCreate");

    return {
      hash: res.result.hash,
      offerSequence: (res.result.tx_json as { Sequence: number }).Sequence,
      owner: wallet.address,
      destination: params.destinationAddress,
      condition,
      cancelAfter,
    };
  });
}

/**
 * El iniciador revela: el `Fulfillment` lleva la preimagen y queda pública en
 * el ledger para siempre. Ese es el disparo que permite cobrar la pierna de
 * Soroban — no hace falta que nadie se la pase por un canal aparte.
 */
export async function revealOnXrpl(params: {
  initiatorSeed: string;
  owner: string;
  offerSequence: number;
  preimage: Buffer;
}): Promise<{ hash: string }> {
  const wallet = Wallet.fromSeed(params.initiatorSeed);

  return withClient(async (client) => {
    const tx: EscrowFinish = {
      TransactionType: "EscrowFinish",
      Account: wallet.address,
      SourceTag: bt.SOURCE_TAG,
      Owner: params.owner,
      OfferSequence: params.offerSequence,
      Condition: bt.xrplCondition(params.preimage),
      Fulfillment: bt.xrplFulfillment(params.preimage),
    };
    // Ojo: el fee de EscrowFinish escala con el tamaño del fulfillment.
    // autofill lo calcula; no asumir fee base.
    const res = await client.submitAndWait(tx, { autofill: true, wallet });
    requireSuccess((res.result.meta as { TransactionResult: string }).TransactionResult, "EscrowFinish");
    return { hash: res.result.hash };
  });
}

/** Camino de reembolso: pasado el CancelAfter, el XRP vuelve al que bloqueó. */
export async function cancelXrplLeg(params: {
  senderSeed: string;
  owner: string;
  offerSequence: number;
}): Promise<{ hash: string }> {
  const wallet = Wallet.fromSeed(params.senderSeed);

  return withClient(async (client) => {
    const tx: EscrowCancel = {
      TransactionType: "EscrowCancel",
      Account: wallet.address,
      SourceTag: bt.SOURCE_TAG,
      Owner: params.owner,
      OfferSequence: params.offerSequence,
    };
    const res = await client.submitAndWait(tx, { autofill: true, wallet });
    requireSuccess((res.result.meta as { TransactionResult: string }).TransactionResult, "EscrowCancel");
    return { hash: res.result.hash };
  });
}

/** Dirección pública de una semilla, sin exponer la semilla. */
export function xrplAddressFromSeed(seed: string): string {
  return Wallet.fromSeed(seed).address;
}

/**
 * ¿Esta dirección existe en el ledger?
 *
 * Que una dirección tenga formato válido no dice nada: una wallet recién
 * creada en Xaman y nunca fondeada no existe para XRPL (`actNotFound`) y no
 * puede firmar. Sin esta comprobación le entregábamos un QR a la persona
 * que más probablemente lo escanee — alguien que acaba de instalar Xaman
 * para esto — y el flujo moría sin explicación.
 *
 * Devuelve `null` si no se pudo saber (RPC caído, timeout). Quien llama debe
 * dejar pasar ese caso: bloquear a todo el mundo porque el nodo no responde
 * es peor que dejar entrar a alguien con una cuenta sin fondear.
 */
export async function accountExists(address: string): Promise<boolean | null> {
  try {
    return await withClient(async (client) => {
      try {
        await client.request({ command: "account_info", account: address, ledger_index: "validated" });
        return true;
      } catch (err) {
        const code = (err as { data?: { error?: string } })?.data?.error;
        if (code === "actNotFound" || String(err).includes("actNotFound")) return false;
        throw err;
      }
    });
  } catch {
    return null;
  }
}

/**
 * Busca en el ledger el `Sequence` de una tx ya confirmada — es lo que hace
 * falta como `OfferSequence` para cancelar el escrow que esa tx creó. No lo
 * devuelve Xaman: solo da el hash, hay que ir a buscarlo.
 */
export async function fetchTxSequence(
  txHash: string,
): Promise<{ account: string; sequence: number; cancelAfterRipple?: number } | null> {
  return withClient(async (client) => {
    const res = await client.request({ command: "tx", transaction: txHash });
    const txJson = res.result.tx_json;
    if (!txJson || typeof txJson.Account !== "string" || typeof txJson.Sequence !== "number") return null;
    // El propio EscrowCreate ya trae su CancelAfter — leerlo de ahí evita
    // depender de un Map en memoria (pendingCancelAfter, retirado) que un
    // reinicio del proceso podía vaciar entre que se creaba el payload y
    // que alguien consultaba su estado, dejando el escrow sin registrar en
    // el sweeper sin ningún error visible.
    const cancelAfter = "CancelAfter" in txJson ? txJson.CancelAfter : undefined;
    return {
      account: txJson.Account,
      sequence: txJson.Sequence,
      cancelAfterRipple: typeof cancelAfter === "number" ? cancelAfter : undefined,
    };
  });
}

/**
 * Plantilla de EscrowCancel SIN firmar y SIN `Account` — reclamo manual del
 * propio usuario, para cuando no hay sweeper fondeado (o solo por no
 * esperarlo). `Account` no importa para saber a dónde va el XRP: XRPL
 * siempre lo devuelve al `Owner` original sin importar quién la firme —
 * puede ser el usuario mismo, con su propia wallet ya activada, sin pedirle
 * fondear nada nuevo.
 */
export function activationCancelTxJson(params: {
  owner: string;
  offerSequence: number;
}): Omit<EscrowCancel, "Account"> {
  return {
    TransactionType: "EscrowCancel",
    SourceTag: bt.SOURCE_TAG,
    Owner: params.owner,
    OfferSequence: params.offerSequence,
  };
}

/**
 * Plantilla de EscrowCreate SIN firmar y SIN `Account` — para Xaman, que
 * rellena `Account` con la wallet que de verdad escanea el QR. Nunca ve una
 * seed ni un Wallet.
 *
 * Es la mitad "armar" del par armar/firmar que exige el T&C de Make Waves:
 * 300 cuentas activas cuentan solo si cada una firma con su propia llave —
 * cualquier automatización de la firma es "scripted transactions", motivo
 * de descalificación (§7).
 *
 * `CancelAfter` solo no basta — probado en vivo contra mainnet (temMALFORMED
 * dos veces): la propia validación de xrpl.js lo confirma, EscrowCreate
 * exige además `Condition` o `FinishAfter`. `FinishAfter` se descartó a
 * propósito: con eso, CUALQUIERA puede mandar `EscrowFinish` pasado ese
 * tiempo y el XRP se va al `Destination`, no de vuelta al dueño — rompe la
 * garantía de que nadie más lo toca. En su lugar, `Condition` con una
 * preimagen aleatoria que se genera aquí y se descarta sin persistir en
 * ningún lado: sin la preimagen, `EscrowFinish` es imposible para
 * cualquiera, ni siquiera para nosotros. La única salida que queda es
 * `EscrowCancel`, que siempre regresa al dueño original.
 */
export function activationTxJson(params: {
  destinationAddress: string;
  amountXrp: string;
  cancelAfterSeconds?: number;
}): Omit<EscrowCreate, "Account"> {
  // 1 h, no 5 min: rippled rechaza el EscrowCreate si CancelAfter ya pasó
  // cuando llega la firma, y el payload de Xaman vive más que eso. Con 300 s
  // quien instalaba Xaman por primera vez firmaba una tx muerta: fee quemado
  // y sin escrow. El plazo solo marca desde cuándo se puede reclamar.
  const cancelAfterSec = params.cancelAfterSeconds ?? 3600;
  const preimage = bt.generatePreimage(); // se usa una vez y se olvida — no se guarda
  return {
    TransactionType: "EscrowCreate",
    SourceTag: bt.SOURCE_TAG,
    Destination: params.destinationAddress,
    Amount: xrpToDrops(params.amountXrp),
    Condition: bt.xrplCondition(preimage),
    CancelAfter: bt.toRippleTime(Math.floor(Date.now() / 1000) + cancelAfterSec),
  };
}
