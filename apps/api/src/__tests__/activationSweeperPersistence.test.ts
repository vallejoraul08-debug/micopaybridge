import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * La lista de escrows por cancelar vivía solo en un Map en memoria: cada
 * reinicio de Railway la vaciaba, y el usuario dependía de reclamar a mano.
 * Este archivo prueba justo la parte que arregla eso — que la cola se
 * guarda y se recupera de Postgres — no el cliente XRPL en sí. Mismo
 * patrón que bazaar-bridge04-db.test.ts: el módulo real corre contra un
 * db/schema.js mockeado, así que el SQL de verdad es lo que se examina.
 * Sin red ni base de datos real.
 */

const schema = vi.hoisted(() => ({
  execute: vi.fn().mockResolvedValue({ rows: [] }),
  getMany: vi.fn().mockResolvedValue([]),
}));
vi.mock("../db/schema.js", () => schema);

const xrplLeg = vi.hoisted(() => ({
  cancelXrplLeg: vi.fn().mockResolvedValue({ hash: "ABCHASH" }),
}));
vi.mock("../lib/xrpl-leg.js", () => xrplLeg);

const CHECK_INTERVAL_MS = 20_000;
const RIPPLE_EPOCH_OFFSET = 946684800;
const toRippleTime = (unixSeconds: number) => unixSeconds - RIPPLE_EPOCH_OFFSET;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  schema.execute.mockResolvedValue({ rows: [] });
  schema.getMany.mockResolvedValue([]);
  xrplLeg.cancelXrplLeg.mockResolvedValue({ hash: "ABCHASH" });
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-03T12:00:00Z"));
  delete process.env.XRPL_SWEEPER_SEED;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("activationSweeper — persistencia en Postgres", () => {
  it("trackActivationEscrow inserta en Postgres con el owner, la secuencia y el CancelAfter correctos", async () => {
    const { trackActivationEscrow } = await import("../lib/activationSweeper.js");

    const cancelAfterRipple = toRippleTime(Math.floor(Date.now() / 1000) + 3600);
    trackActivationEscrow({ owner: "rOwner123", offerSequence: 42, cancelAfterRipple });
    await vi.runOnlyPendingTimersAsync();

    expect(schema.execute).toHaveBeenCalledTimes(1);
    const [sql, params] = schema.execute.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO activation_sweeper_queue/i);
    expect(sql).toMatch(/ON CONFLICT \(owner, offer_sequence\) DO NOTHING/i);
    expect(params).toEqual(["rOwner123", 42, Math.floor(Date.now() / 1000) + 3600]);
  });

  it("recupera lo que Postgres tenía guardado y lo cancela cuando el plazo ya pasó", async () => {
    const cancelAfterUnixPasado = Math.floor(Date.now() / 1000) - 60;
    schema.getMany.mockResolvedValue([
      { owner: "rRecuperado", offer_sequence: 7, cancel_after_unix: String(cancelAfterUnixPasado) },
    ]);
    process.env.XRPL_SWEEPER_SEED = "sSEEDDEPRUEBA";

    const { startActivationSweeper } = await import("../lib/activationSweeper.js");
    startActivationSweeper();
    // recuperarPendientes() no se espera en el arranque — deja correr sus
    // microtareas antes de avanzar el reloj.
    await vi.waitFor(() => expect(schema.getMany).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);

    expect(xrplLeg.cancelXrplLeg).toHaveBeenCalledWith({
      senderSeed: "sSEEDDEPRUEBA",
      owner: "rRecuperado",
      offerSequence: 7,
    });
    // Cancelado con éxito: se borra de Postgres para no volver a intentarlo.
    const deleteCall = schema.execute.mock.calls.find(([sql]) => /DELETE FROM activation_sweeper_queue/i.test(sql));
    expect(deleteCall?.[1]).toEqual(["rRecuperado", 7]);
  });

  it("si Postgres no responde al arrancar, arranca vacío sin tirar", async () => {
    schema.getMany.mockRejectedValue(new Error("connection refused"));
    process.env.XRPL_SWEEPER_SEED = "sSEEDDEPRUEBA";

    const { startActivationSweeper } = await import("../lib/activationSweeper.js");
    expect(() => startActivationSweeper()).not.toThrow();
    await vi.waitFor(() => expect(schema.getMany).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);

    expect(xrplLeg.cancelXrplLeg).not.toHaveBeenCalled();
  });

  it("si Postgres falla al guardar, el escrow sigue vigilado en memoria durante este proceso", async () => {
    schema.execute.mockRejectedValue(new Error("connection refused"));
    process.env.XRPL_SWEEPER_SEED = "sSEEDDEPRUEBA";

    const { trackActivationEscrow, startActivationSweeper } = await import("../lib/activationSweeper.js");
    const cancelAfterRipple = toRippleTime(Math.floor(Date.now() / 1000) - 10);
    expect(() => trackActivationEscrow({ owner: "rSinPersistir", offerSequence: 3, cancelAfterRipple })).not.toThrow();

    startActivationSweeper();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);

    expect(xrplLeg.cancelXrplLeg).toHaveBeenCalledWith({
      senderSeed: "sSEEDDEPRUEBA",
      owner: "rSinPersistir",
      offerSequence: 3,
    });
  });
});
