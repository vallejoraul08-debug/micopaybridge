import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";

/**
 * Reproducido en vivo el 2026-09-03: un escrow firmado por el link directo
 * de Xaman nunca se registró en el sweeper, y su CancelAfter pasó de largo
 * sin que nada lo cancelara. La causa: el CancelAfter vivía en un Map en
 * memoria (pendingCancelAfter, en xumm.ts) sembrado al crear el payload y
 * leído solo una vez al detectar la firma — si el proceso se reiniciaba
 * entre esos dos momentos, la entrada desaparecía sin ningún error visible.
 *
 * El arreglo: el CancelAfter se lee del propio EscrowCreate ya confirmado
 * (fetchTxSequence ahora lo trae de vuelta junto con Account/Sequence), no
 * de memoria efímera. Este test prueba justo eso — que la ruta de estado
 * saca el CancelAfter del resultado de fetchTxSequence, no de un caché — y
 * que repetir el poll no rompe nada, porque ahora es idempotente.
 */

const xumm = vi.hoisted(() => ({
  xummConfigured: vi.fn(() => true),
  createActivationPayload: vi.fn(),
  createCancelPayload: vi.fn(),
  getActivationPayloadStatus: vi.fn(),
}));
vi.mock("../lib/xumm.js", () => xumm);

const xrplLeg = vi.hoisted(() => ({
  accountExists: vi.fn(async () => true),
  fetchTxSequence: vi.fn(),
}));
vi.mock("../lib/xrpl-leg.js", () => xrplLeg);

const sweeper = vi.hoisted(() => ({
  trackActivationEscrow: vi.fn(),
}));
vi.mock("../lib/activationSweeper.js", () => sweeper);

const RIPPLE_EPOCH_OFFSET = 946684800;

describe("GET /activation/payload/:uuid — de dónde sale el CancelAfter que ve el sweeper", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { activationRoutes } = await import("../routes/activation.js");
    app = Fastify();
    await app.register(activationRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    xumm.xummConfigured.mockReturnValue(true);
  });

  it("usa el CancelAfter que trae fetchTxSequence, sin depender de haber visto el uuid antes", async () => {
    xumm.getActivationPayloadStatus.mockResolvedValue({
      resolved: true,
      signed: true,
      cancelled: false,
      expired: false,
      txid: "TX_NUNCA_ANTES_VISTO",
      account: "rOwner",
      dispatchedResult: "tesSUCCESS",
    });
    const cancelAfterRipple = 900_000_000;
    xrplLeg.fetchTxSequence.mockResolvedValue({ account: "rOwner", sequence: 55, cancelAfterRipple });

    const res = await app.inject({ method: "GET", url: "/api/v1/xrpl/activation/payload/un-uuid-cualquiera" });
    // La ruta responde antes de que termine de registrar en el sweeper
    // (fire-and-forget) — hay que dejarle un tick para que corra el .then().
    await new Promise((r) => setImmediate(r));

    expect(res.statusCode).toBe(200);
    expect(sweeper.trackActivationEscrow).toHaveBeenCalledWith({
      owner: "rOwner",
      offerSequence: 55,
      cancelAfterRipple,
    });
  });

  it("registra en cada poll firmado, no solo el primero — es idempotente por diseño", async () => {
    xumm.getActivationPayloadStatus.mockResolvedValue({
      resolved: true,
      signed: true,
      cancelled: false,
      expired: false,
      txid: "TX_REPETIDO",
      account: "rOwner",
      dispatchedResult: "tesSUCCESS",
    });
    xrplLeg.fetchTxSequence.mockResolvedValue({ account: "rOwner", sequence: 9, cancelAfterRipple: 900_000_100 });

    await app.inject({ method: "GET", url: "/api/v1/xrpl/activation/payload/mismo-uuid" });
    await new Promise((r) => setImmediate(r));
    await app.inject({ method: "GET", url: "/api/v1/xrpl/activation/payload/mismo-uuid" });
    await new Promise((r) => setImmediate(r));

    // Dos polls firmados, dos intentos de registro — el Map y el
    // ON CONFLICT DO NOTHING de Postgres son quienes absorben la repetición,
    // no esta ruta.
    expect(sweeper.trackActivationEscrow).toHaveBeenCalledTimes(2);
  });

  it("si la tx no trae CancelAfter, avisa y no registra nada a ciegas", async () => {
    xumm.getActivationPayloadStatus.mockResolvedValue({
      resolved: true,
      signed: true,
      cancelled: false,
      expired: false,
      txid: "TX_SIN_CANCELAFTER",
      account: "rOwner",
      dispatchedResult: "tesSUCCESS",
    });
    xrplLeg.fetchTxSequence.mockResolvedValue({ account: "rOwner", sequence: 1, cancelAfterRipple: undefined });

    const res = await app.inject({ method: "GET", url: "/api/v1/xrpl/activation/payload/sin-cancelafter" });
    await new Promise((r) => setImmediate(r));

    expect(res.statusCode).toBe(200);
    expect(sweeper.trackActivationEscrow).not.toHaveBeenCalled();
  });
});
