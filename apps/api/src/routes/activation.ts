import type { FastifyInstance } from "fastify";
import { isValidClassicAddress } from "xrpl";
import {
  createActivationPayload,
  createCancelPayload,
  getActivationPayloadStatus,
  xummConfigured,
} from "../lib/xumm.js";
import { accountExists, fetchTxSequence } from "../lib/xrpl-leg.js";
import { trackActivationEscrow } from "../lib/activationSweeper.js";

/**
 * Endpoint público (sin x402, sin login) para la estrategia de 300 cuentas
 * de Make Waves: arma la transacción y crea un payload de Xaman, el usuario
 * la firma escaneando el QR o abriendo el deep link con su propia wallet.
 * Ver docs/ESTRATEGIA_300_CUENTAS.md.
 *
 * A propósito NUNCA toca una seed ni firma nada — solo pide a Xaman que
 * arme el payload y luego pregunta su estado. Firmar aquí sería exactamente
 * el "scripted transactions" que el T&C prohíbe (§7).
 */
export async function activationRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{
    Body: { account: string; amountXrp?: string; cancelAfterSeconds?: number };
  }>(
    "/api/v1/xrpl/activation/payload",
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      if (!xummConfigured()) {
        return reply.status(503).send({
          error: "Xaman no está configurado (XUMM_API_KEY/XUMM_API_SECRET) — pide credenciales en apps.xaman.dev",
        });
      }

      const { account, amountXrp, cancelAfterSeconds } = request.body ?? {};
      if (typeof account !== "string" || !isValidClassicAddress(account)) {
        return reply.status(400).send({ error: "account debe ser una dirección XRPL válida — es tu propia dirección, se autobloquea a sí misma" });
      }

      const amount = amountXrp ?? "1";
      const amountNum = Number(amount);
      if (!Number.isFinite(amountNum) || amountNum <= 0 || amountNum > 50) {
        return reply.status(400).send({ error: "amountXrp debe ser un número entre 0 y 50" });
      }
      if (
        cancelAfterSeconds !== undefined &&
        (!Number.isInteger(cancelAfterSeconds) || cancelAfterSeconds < 600 || cancelAfterSeconds > 86400)
      ) {
        // Mínimo 600 y no 60: la expiración del payload se deriva de este
        // plazo menos el margen de firma, así que por debajo de 10 min no
        // queda ventana en la que el usuario alcance a firmar algo válido.
        return reply.status(400).send({ error: "cancelAfterSeconds debe estar entre 600 y 86400" });
      }

      // Una wallet recién creada en Xaman y sin fondear no existe para XRPL
      // y no puede firmar nada. Decirlo aquí, y no dejar que descubra un QR
      // muerto. `null` = no se pudo comprobar; se deja pasar a propósito.
      if ((await accountExists(account)) === false) {
        return reply.status(400).send({
          error:
            "esa dirección todavía no existe en XRPL — hay que fondearla con al menos 2.2 XRP (1 de reserva de la cuenta, 0.2 que queda retenida por el escrow, más lo que vayas a bloquear)",
        });
      }

      try {
        const payload = await createActivationPayload({ accountAddress: account, amountXrp: amount, cancelAfterSeconds });
        return reply.send(payload);
      } catch (err) {
        request.log.error(err, "activation/payload falló");
        return reply.status(502).send({ error: "no se pudo crear el payload de Xaman — reintenta" });
      }
    },
  );

  fastify.post<{
    Body: { txid: string };
  }>(
    "/api/v1/xrpl/activation/reclaim",
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      if (!xummConfigured()) {
        return reply.status(503).send({ error: "Xaman no está configurado" });
      }

      const { txid } = request.body ?? {};
      if (typeof txid !== "string" || txid.length < 10) {
        return reply.status(400).send({ error: "txid inválido — es el hash de tu EscrowCreate ya firmado" });
      }

      try {
        const seq = await fetchTxSequence(txid);
        if (!seq) {
          return reply.status(404).send({ error: "no se encontró esa transacción en el ledger todavía — espera a que confirme" });
        }
        const payload = await createCancelPayload({ owner: seq.account, offerSequence: seq.sequence });
        return reply.send(payload);
      } catch (err) {
        request.log.error(err, "activation/reclaim falló");
        return reply.status(502).send({ error: "no se pudo armar el reclamo — reintenta" });
      }
    },
  );

  fastify.get<{ Params: { uuid: string } }>(
    "/api/v1/xrpl/activation/payload/:uuid",
    {
      config: {
        rateLimit: {
          max: 120,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      if (!xummConfigured()) {
        return reply.status(503).send({ error: "Xaman no está configurado" });
      }
      try {
        const status = await getActivationPayloadStatus(request.params.uuid);

        if (status.signed && status.txid && status.account && status.dispatchedResult === "tesSUCCESS") {
          // El CancelAfter se lee del propio EscrowCreate ya confirmado, no
          // de un Map en memoria keyed por uuid — ese Map (retirado) tenía
          // una ventana de carrera real: si el proceso se reiniciaba entre
          // crear el payload y que alguien consultara su estado, la entrada
          // desaparecía y el escrow quedaba sin registrar en el sweeper sin
          // ningún error visible. Así se reprodujo en vivo el 2026-09-03.
          //
          // Se llama en cada poll que llega firmado, no solo el primero: es
          // idempotente (INSERT ... ON CONFLICT DO NOTHING en Postgres, y el
          // Map del sweeper se sobreescribe por la misma clave), así que
          // repetir la llamada no tiene costo — y ahora basta con que UN
          // poll después de firmar llegue a buen puerto, no exactamente el
          // primero.
          fetchTxSequence(status.txid)
            .then((seq) => {
              if (!seq) {
                request.log.warn(`no se encontró Sequence para ${status.txid} — el sweeper no podrá cancelarlo solo`);
                return;
              }
              if (seq.cancelAfterRipple === undefined) {
                request.log.warn(`${status.txid} no trae CancelAfter — el sweeper no podrá cancelarlo solo`);
                return;
              }
              trackActivationEscrow({
                owner: seq.account,
                offerSequence: seq.sequence,
                cancelAfterRipple: seq.cancelAfterRipple,
              });
            })
            .catch((err) => request.log.error(err, "no se pudo registrar el escrow en el sweeper"));
        }

        return reply.send(status);
      } catch (err) {
        request.log.error(err, "activation/payload status falló");
        return reply.status(404).send({ error: "payload no encontrado o expirado" });
      }
    },
  );
}
