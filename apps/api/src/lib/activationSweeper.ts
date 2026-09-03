/**
 * "Se regresa solo" solo es cierto si alguien manda el EscrowCancel — XRPL
 * no ejecuta nada por su cuenta. Esto es ese "alguien": revisa cada
 * escrow de activación pendiente y, pasado su CancelAfter, cancela.
 *
 * Cualquier cuenta puede mandar EscrowCancel y el XRP siempre vuelve al
 * dueño original (regla de XRPL, no de este código) — así que el firmante
 * de la cancelación no necesita ser el usuario. Aun así, sin
 * XRPL_SWEEPER_SEED configurado y fondeado en la red correcta, esto no
 * puede mandar nada: se queda avisando en el log, no revienta el server.
 *
 * La lista de pendientes vive en memoria Y en Postgres. Railway reinicia
 * el proceso en cada deploy — sin la tabla, cada reinicio olvidaba qué
 * escrows estaba vigilando y el usuario se quedaba dependiendo del botón
 * de reclamo manual. Postgres es respaldo, no fuente de verdad en caliente:
 * si no está disponible, el sweeper sigue operando en memoria como antes,
 * solo que no sobrevive al próximo reinicio — igual que se comportaba esta
 * pieza hasta ahora.
 */
import * as bt from "@micopaybridge/xrpl-bridge/bridge-translate";
import { cancelXrplLeg } from "./xrpl-leg.js";
import { execute, getMany } from "../db/schema.js";

interface PendingCancel {
  owner: string;
  offerSequence: number;
  cancelAfterUnix: number;
  attempts: number;
}

const MAX_ATTEMPTS = 20;
const CHECK_INTERVAL_MS = 20_000;

const pending = new Map<string, PendingCancel>();
let started = false;

function key(owner: string, offerSequence: number): string {
  return `${owner}:${offerSequence}`;
}

/**
 * Best-effort: nunca tira. Un fallo de Postgres aquí no debe impedir que la
 * activación en curso responda al usuario — la entrada ya quedó en el Map,
 * que es lo único que este proceso necesita para funcionar hasta que
 * reinicie.
 */
async function persistir(entry: PendingCancel): Promise<void> {
  try {
    await execute(
      `INSERT INTO activation_sweeper_queue (owner, offer_sequence, cancel_after)
       VALUES ($1, $2, to_timestamp($3))
       ON CONFLICT (owner, offer_sequence) DO NOTHING`,
      [entry.owner, entry.offerSequence, entry.cancelAfterUnix],
    );
  } catch (err) {
    console.warn(
      `[activation-sweeper] no se pudo persistir owner=${entry.owner} seq=${entry.offerSequence} — sigue en memoria, no sobrevivirá un reinicio: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function olvidar(owner: string, offerSequence: number): Promise<void> {
  try {
    await execute(
      `DELETE FROM activation_sweeper_queue WHERE owner = $1 AND offer_sequence = $2`,
      [owner, offerSequence],
    );
  } catch (err) {
    console.warn(
      `[activation-sweeper] no se pudo borrar owner=${owner} seq=${offerSequence} de Postgres — queda huérfano ahí, sin efecto en el proceso actual: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Recupera lo que quedó pendiente antes del último reinicio. Se llama una
 * vez al arrancar; si Postgres no responde, arranca con la lista vacía —
 * el comportamiento de siempre, no uno nuevo.
 *
 * `attempts` no se persiste a propósito: no es una cuenta que importe
 * entre procesos. Tras un reinicio cada entrada recuperada empieza su
 * propio presupuesto de reintentos desde cero, lo cual es más indulgente
 * que perder el escrow por una racha de fallos de antes del reinicio.
 */
async function recuperarPendientes(): Promise<void> {
  try {
    const filas = await getMany<{ owner: string; offer_sequence: number; cancel_after_unix: string }>(
      `SELECT owner, offer_sequence, EXTRACT(EPOCH FROM cancel_after)::bigint AS cancel_after_unix
       FROM activation_sweeper_queue`,
    );
    for (const fila of filas) {
      const k = key(fila.owner, fila.offer_sequence);
      if (pending.has(k)) continue; // ya lo trackeó esta misma corrida
      pending.set(k, {
        owner: fila.owner,
        offerSequence: fila.offer_sequence,
        cancelAfterUnix: Number(fila.cancel_after_unix),
        attempts: 0,
      });
    }
    if (filas.length > 0) {
      console.log(`[activation-sweeper] recuperados ${filas.length} escrow(s) pendientes de antes del reinicio`);
    }
  } catch (err) {
    console.warn(
      `[activation-sweeper] no se pudo leer Postgres al arrancar — arranca sin lo pendiente de antes: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Se llama en cuanto se sabe que el escrow quedó confirmado on-chain. */
export function trackActivationEscrow(params: {
  owner: string;
  offerSequence: number;
  cancelAfterRipple: number;
}): void {
  const cancelAfterUnix = bt.fromRippleTime(params.cancelAfterRipple);
  const entry: PendingCancel = {
    owner: params.owner,
    offerSequence: params.offerSequence,
    cancelAfterUnix,
    attempts: 0,
  };
  pending.set(key(params.owner, params.offerSequence), entry);
  void persistir(entry);
}

async function sweepOnce(): Promise<void> {
  const seed = process.env.XRPL_SWEEPER_SEED;
  if (!seed) {
    if (pending.size > 0) {
      console.warn(
        `[activation-sweeper] XRPL_SWEEPER_SEED no configurado — ${pending.size} escrow(s) esperando cancelación manual`,
      );
    }
    return;
  }

  const nowUnix = Math.floor(Date.now() / 1000);
  for (const [k, entry] of pending.entries()) {
    if (nowUnix < entry.cancelAfterUnix) continue;

    try {
      const { hash } = await cancelXrplLeg({
        senderSeed: seed,
        owner: entry.owner,
        offerSequence: entry.offerSequence,
      });
      console.log(`[activation-sweeper] cancelado owner=${entry.owner} seq=${entry.offerSequence} hash=${hash}`);
      pending.delete(k);
      void olvidar(entry.owner, entry.offerSequence);
    } catch (err) {
      entry.attempts += 1;
      const msg = err instanceof Error ? err.message : String(err);
      // tecNO_TARGET: ya no existe (alguien más lo canceló, o ya se resolvió) — no es un fallo.
      if (msg.includes("tecNO_TARGET")) {
        console.log(`[activation-sweeper] owner=${entry.owner} seq=${entry.offerSequence} ya no existe — nada que hacer`);
        pending.delete(k);
        void olvidar(entry.owner, entry.offerSequence);
        continue;
      }
      console.warn(`[activation-sweeper] intento ${entry.attempts}/${MAX_ATTEMPTS} falló owner=${entry.owner} seq=${entry.offerSequence}: ${msg}`);
      if (entry.attempts >= MAX_ATTEMPTS) {
        console.error(`[activation-sweeper] owner=${entry.owner} seq=${entry.offerSequence} se rindió tras ${MAX_ATTEMPTS} intentos — necesita revisión manual`);
        pending.delete(k);
        void olvidar(entry.owner, entry.offerSequence);
      }
    }
  }
}

/** Un solo intervalo para todo el proceso — llamar una vez al arrancar. */
export function startActivationSweeper(): void {
  if (started) return;
  started = true;
  // No se espera aquí: arrancar el servidor no debe depender de que
  // Postgres responda. El primer sweepOnce() ya corre con lo que se haya
  // recuperado para entonces, o vacío si Postgres tardó más que el primer
  // intervalo.
  void recuperarPendientes();
  setInterval(() => {
    sweepOnce().catch((err) => console.error("[activation-sweeper] sweep falló", err));
  }, CHECK_INTERVAL_MS);
}
