import { useState, useCallback, useEffect, useRef } from "react";

interface Props {
  apiUrl: string;
}

interface Payload {
  uuid: string;
  qrPng: string;
  deepLink: string;
}

type Step = "idle" | "creating" | "waiting" | "done" | "error";
type ReclaimStep = "idle" | "creating" | "waiting" | "done" | "error";

const CANCEL_AFTER_SECONDS = 3600; // default de activationTxJson en el backend

// `pointer: coarse` y no el ancho: lo que decide si el QR sirve es si hay un
// dedo o un ratón, no cuántos píxeles mide la ventana. Una laptop con pantalla
// chica sí puede escanear con el teléfono; un móvil en horizontal no.
const enTelefono =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(pointer: coarse)").matches
    : false;

// Sin custodia: el backend arma la transacción y crea un payload de Xaman
// (QR + deep link), pero quien firma es la propia wallet del usuario —
// escaneando o abriendo la app. El backend nunca ve una seed. Ver
// docs/ESTRATEGIA_300_CUENTAS.md — es el único diseño que no pisa la
// cláusula anti-sybil del T&C de Make Waves (§7): automatizar la firma del
// lado del team sería "scripted transactions".
/**
 * El plazo para reclamar es de una hora, y nadie se va a quedar mirando la
 * pantalla ese rato. Si el estado vive solo en memoria, cerrar la pestaña
 * deja a la persona con su XRP bloqueado y sin el botón para recuperarlo —
 * el escrow sigue en la cadena, pero habría que armar el EscrowCancel a mano.
 * Guardarlo aquí es lo que permite volver más tarde y reclamar.
 */
const CLAVE_ACTIVACION = "micopay.activacion";

interface ActivacionGuardada {
  txid: string;
  signedAt: number;
  account: string;
}

function leerActivacion(): ActivacionGuardada | null {
  try {
    const crudo = localStorage.getItem(CLAVE_ACTIVACION);
    if (!crudo) return null;
    const v = JSON.parse(crudo) as ActivacionGuardada;
    if (typeof v?.txid !== "string" || typeof v?.signedAt !== "number") return null;
    // Una semana. Pasado eso lo normal es que ya se haya reclamado; dejar el
    // registro solo serviría para ofrecer un reclamo que fallaría con
    // tecNO_TARGET.
    if (Date.now() - v.signedAt > 7 * 24 * 60 * 60 * 1000) return null;
    return v;
  } catch {
    // Modo incógnito o almacenamiento bloqueado: se degrada al comportamiento
    // de antes, no se rompe.
    return null;
  }
}

function guardarActivacion(v: ActivacionGuardada): void {
  try {
    localStorage.setItem(CLAVE_ACTIVACION, JSON.stringify(v));
  } catch {
    /* sin persistencia; el flujo sigue funcionando en esta pestaña */
  }
}

function olvidarActivacion(): void {
  try {
    localStorage.removeItem(CLAVE_ACTIVACION);
  } catch {
    /* nada que hacer */
  }
}

export default function ActivationPanel({ apiUrl }: Props) {
  const guardada = leerActivacion();
  const [step, setStep] = useState<Step>(guardada ? "done" : "idle");
  const [account, setAccount] = useState(guardada?.account ?? "");
  const [amountXrp, setAmountXrp] = useState("1");
  const [payload, setPayload] = useState<Payload | null>(null);
  const [txid, setTxid] = useState<string | null>(guardada?.txid ?? null);
  const [signedAt, setSignedAt] = useState<number | null>(guardada?.signedAt ?? null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [reclaimStep, setReclaimStep] = useState<ReclaimStep>("idle");
  const [reclaimPayload, setReclaimPayload] = useState<Payload | null>(null);
  const [reclaimTxid, setReclaimTxid] = useState<string | null>(null);
  const [reclaimError, setReclaimError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const reclaimPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const stopReclaimPolling = useCallback(() => {
    if (reclaimPollRef.current) {
      clearInterval(reclaimPollRef.current);
      reclaimPollRef.current = null;
    }
  }, []);

  useEffect(() => stopReclaimPolling, [stopReclaimPolling]);

  // Cuenta regresiva hasta que el CancelAfter ya pasó — antes de eso XRPL
  // rechaza el EscrowCancel (tecNO_PERMISSION), no tiene caso ni intentarlo.
  useEffect(() => {
    if (!signedAt) return;
    const tick = () => {
      const left = CANCEL_AFTER_SECONDS - Math.floor((Date.now() - signedAt) / 1000);
      setSecondsLeft(Math.max(0, left));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [signedAt]);

  const start = useCallback(async () => {
    if (!account.trim().startsWith("r") || account.trim().length < 20) {
      setStep("error");
      setError("Pega tu dirección XRPL completa (empieza con 'r')");
      return;
    }
    setStep("creating");
    setError(null);
    setPayload(null);
    setTxid(null);
    try {
      const res = await fetch(`${apiUrl}/api/v1/xrpl/activation/payload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: account.trim(), amountXrp }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `El servidor respondió ${res.status}`);
      }
      const created: Payload = await res.json();
      setPayload(created);
      setStep("waiting");

      pollRef.current = setInterval(async () => {
        try {
          const statusRes = await fetch(`${apiUrl}/api/v1/xrpl/activation/payload/${created.uuid}`);
          if (!statusRes.ok) return;
          const status = await statusRes.json();
          if (status.signed && status.txid) {
            // signed:true solo dice que aprobaste en Xaman — hay que
            // revisar si la red de verdad la aceptó antes de celebrar.
            if (status.dispatchedResult && status.dispatchedResult !== "tesSUCCESS") {
              stopPolling();
              setStep("error");
              setError(`La red rechazó la transacción: ${status.dispatchedResult}`);
              return;
            }
            stopPolling();
            const firmadoEn = Date.now();
            setTxid(status.txid);
            setSignedAt(firmadoEn);
            setStep("done");
            // A partir de aquí la persona puede cerrar la pestaña: al volver
            // encuentra el reclamo esperándola.
            guardarActivacion({ txid: status.txid, signedAt: firmadoEn, account: account.trim() });
          } else if (status.cancelled || status.expired) {
            stopPolling();
            setStep("error");
            setError(status.cancelled ? "Cancelaste la firma en la app" : "El código expiró — intenta de nuevo");
          }
        } catch {
          // un fallo de red puntual no debe tumbar el polling
        }
      }, 2000);
    } catch (err) {
      setStep("error");
      setError(err instanceof Error ? err.message : "No se pudo crear el código de firma");
    }
  }, [account, amountXrp, apiUrl, stopPolling]);

  const reclaim = useCallback(async () => {
    if (!txid) return;
    setReclaimStep("creating");
    setReclaimError(null);
    setReclaimPayload(null);
    setReclaimTxid(null);
    try {
      const res = await fetch(`${apiUrl}/api/v1/xrpl/activation/reclaim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txid }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `El servidor respondió ${res.status}`);
      }
      const created: Payload = await res.json();
      setReclaimPayload(created);
      setReclaimStep("waiting");

      reclaimPollRef.current = setInterval(async () => {
        try {
          const statusRes = await fetch(`${apiUrl}/api/v1/xrpl/activation/payload/${created.uuid}`);
          if (!statusRes.ok) return;
          const status = await statusRes.json();
          if (status.signed && status.txid) {
            if (status.dispatchedResult && status.dispatchedResult !== "tesSUCCESS") {
              stopReclaimPolling();
              setReclaimStep("error");
              setReclaimError(
                status.dispatchedResult === "tecNO_PERMISSION"
                  ? "Todavía no pasa el tiempo de espera — intenta en unos minutos"
                  : `La red rechazó la cancelación: ${status.dispatchedResult}`,
              );
              return;
            }
            stopReclaimPolling();
            setReclaimTxid(status.txid);
            setReclaimStep("done");
            // Reclamado: el registro ya no sirve y ofrecerlo otra vez daría
            // tecNO_TARGET.
            olvidarActivacion();
          } else if (status.cancelled || status.expired) {
            stopReclaimPolling();
            setReclaimStep("error");
            setReclaimError(status.cancelled ? "Cancelaste la firma en la app" : "El código expiró — intenta de nuevo");
          }
        } catch {
          // un fallo de red puntual no debe tumbar el polling
        }
      }, 2000);
    } catch (err) {
      setReclaimStep("error");
      setReclaimError(err instanceof Error ? err.message : "No se pudo crear el código de reclamo");
    }
  }, [txid, apiUrl, stopReclaimPolling]);

  const box: React.CSSProperties = {
    background: "#111827",
    border: "1px solid #1f2937",
    borderRadius: "0.5rem",
    padding: "1.5rem",
    marginBottom: "1rem",
  };

  const buttonStyle: React.CSSProperties = {
    padding: "0.6rem 1.2rem",
    fontSize: "0.875rem",
    background: "#4ade80",
    color: "#052e16",
    border: "none",
    borderRadius: "0.375rem",
    fontWeight: "bold",
    cursor: "pointer",
  };

  return (
    <div>
      <div style={box}>
        <h2 style={{ margin: "0 0 0.5rem", fontSize: "1.25rem", color: "white" }}>
          Activa tu cuenta en el puente
        </h2>
        <p style={{ margin: 0, fontSize: "0.875rem", color: "#9ca3af", lineHeight: "1.6" }}>
          Bloqueas un poco de XRP en un <code>EscrowCreate</code> real —
          nunca puede cobrarlo nadie más que tú, y lo reclamas cuando quieras.
          Escaneas con <strong style={{ color: "#e5e7eb" }}>Xaman</strong> y firmas ahí —
          nosotros nunca vemos tu llave.
        </p>
      </div>

      {(step === "idle" || step === "creating" || step === "error") && (
        <div style={box}>
          <label style={{ display: "block", fontSize: "0.8rem", color: "#9ca3af", marginBottom: "0.4rem" }}>
            Tu dirección XRPL (te bloqueas a ti mismo — Destination = Account)
          </label>
          <input
            type="text"
            placeholder="rXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            style={{
              width: "100%",
              padding: "0.5rem 0.75rem",
              background: "#0f172a",
              border: "1px solid #1f2937",
              borderRadius: "0.375rem",
              color: "white",
              fontSize: "0.8rem",
              fontFamily: "monospace",
              marginBottom: "1rem",
            }}
          />
          <label style={{ display: "block", fontSize: "0.8rem", color: "#9ca3af", marginBottom: "0.4rem" }}>
            Monto a bloquear (XRP)
          </label>
          <input
            type="number"
            min="0.1"
            max="50"
            step="0.1"
            value={amountXrp}
            onChange={(e) => setAmountXrp(e.target.value)}
            style={{
              width: "100%",
              padding: "0.5rem 0.75rem",
              background: "#0f172a",
              border: "1px solid #1f2937",
              borderRadius: "0.375rem",
              color: "white",
              fontSize: "0.875rem",
              marginBottom: "1rem",
            }}
          />
          <button
            onClick={start}
            disabled={step === "creating"}
            style={{ ...buttonStyle, opacity: step === "creating" ? 0.6 : 1 }}
          >
            {step === "creating" ? "Generando código..." : "Generar código para firmar"}
          </button>
          {error && (
            <p style={{ margin: "0.75rem 0 0", fontSize: "0.8rem", color: "#f87171" }}>{error}</p>
          )}
        </div>
      )}

      {step === "waiting" && payload && (
        <div style={{ ...box, textAlign: "center" }}>
          {/* En un teléfono el QR es inútil — nadie escanea su propia pantalla —
              y ocupaba el lugar de lo único accionable. El deep link va primero
              ahí, y el QR queda como alternativa para quien abrió en la
              computadora. No se navega solo al abrir: si no tienen Xaman
              instalado acaban en una pantalla rota sin contexto, y iOS bloquea
              la navegación que no nace de un gesto del usuario. */}
          {!enTelefono && (
            <img
              src={payload.qrPng}
              alt="Código QR de Xaman"
              style={{ width: "220px", height: "220px", margin: "0 auto 1rem", borderRadius: "0.5rem" }}
            />
          )}
          <a
            href={payload.deepLink}
            target="_blank"
            rel="noopener noreferrer"
            style={{ ...buttonStyle, display: "inline-block", textDecoration: "none" }}
          >
            Abrir en Xaman
          </a>
          {enTelefono ? (
            /* Abierto de entrada: el botón sigue siendo lo primero, pero el QR
               se ve sin tener que tocar nada — a quien lo abrió en la
               computadora, o tiene Xaman en un segundo teléfono, no le pedimos
               un paso extra para encontrarlo. Se puede plegar. */
            <details open style={{ marginTop: "1rem" }}>
              <summary style={{ fontSize: "0.8rem", color: "#9ca3af", cursor: "pointer" }}>
                ¿Tienes Xaman en otro teléfono? Escanea el código
              </summary>
              <img
                src={payload.qrPng}
                alt="Código QR de Xaman"
                style={{ width: "200px", height: "200px", margin: "1rem auto 0", borderRadius: "0.5rem" }}
              />
            </details>
          ) : (
            <p style={{ margin: "1rem 0 0", fontSize: "0.8rem", color: "#9ca3af" }}>
              Escanea el código con la app de Xaman, o abre desde este dispositivo
            </p>
          )}
          <p style={{ margin: "1rem 0 0", fontSize: "0.75rem", color: "#4b5563" }}>
            Esperando que firmes...
          </p>
        </div>
      )}

      {step === "done" && txid && (
        <div style={box}>
          <p style={{ margin: "0 0 0.5rem", fontSize: "0.95rem", color: "#4ade80", fontWeight: "bold" }}>
            ✓ Activado on-chain
          </p>
          <code style={{ fontSize: "0.75rem", color: "#9ca3af", wordBreak: "break-all" }}>{txid}</code>
          {/* Salida para quien vuelve a una activación ya reclamada desde otro
              lado: sin esto se queda mirando un reclamo que fallaría, y sin
              forma de empezar otra. */}
          <button
            type="button"
            onClick={() => {
              olvidarActivacion();
              setStep("idle");
              setTxid(null);
              setSignedAt(null);
              setReclaimStep("idle");
              setReclaimPayload(null);
              setReclaimTxid(null);
              setReclaimError(null);
            }}
            style={{
              display: "block",
              margin: "0.9rem 0 0",
              padding: 0,
              background: "none",
              border: "none",
              color: "#6b7280",
              fontSize: "0.75rem",
              fontFamily: "inherit",
              textDecoration: "underline",
              cursor: "pointer",
            }}
          >
            Empezar una activación nueva
          </button>
        </div>
      )}

      {step === "done" && (reclaimStep === "idle" || reclaimStep === "creating" || reclaimStep === "error") && (
        <div style={box}>
          <p style={{ margin: "0 0 1rem", fontSize: "0.875rem", color: "#9ca3af" }}>
            Reclama tu XRP de vuelta — lo firmas tú mismo, sin esperar a nadie más.
          </p>
          <button
            onClick={reclaim}
            disabled={secondsLeft > 0 || reclaimStep === "creating"}
            style={{ ...buttonStyle, opacity: secondsLeft > 0 || reclaimStep === "creating" ? 0.5 : 1 }}
          >
            {secondsLeft > 0
              ? `Disponible en ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`
              : reclaimStep === "creating"
                ? "Generando código..."
                : "Reclamar mi XRP"}
          </button>
          {reclaimError && (
            <p style={{ margin: "0.75rem 0 0", fontSize: "0.8rem", color: "#f87171" }}>{reclaimError}</p>
          )}
        </div>
      )}

      {step === "done" && reclaimStep === "waiting" && reclaimPayload && (
        <div style={{ ...box, textAlign: "center" }}>
          <img
            src={reclaimPayload.qrPng}
            alt="Código QR de Xaman — reclamo"
            style={{ width: "220px", height: "220px", margin: "0 auto 1rem", borderRadius: "0.5rem" }}
          />
          <p style={{ margin: "0 0 1rem", fontSize: "0.8rem", color: "#9ca3af" }}>
            Escanea o abre en Xaman para confirmar el reclamo
          </p>
          <a
            href={reclaimPayload.deepLink}
            target="_blank"
            rel="noopener noreferrer"
            style={{ ...buttonStyle, display: "inline-block", textDecoration: "none" }}
          >
            Abrir en Xaman
          </a>
        </div>
      )}

      {step === "done" && reclaimStep === "done" && reclaimTxid && (
        <div style={box}>
          <p style={{ margin: "0 0 0.5rem", fontSize: "0.95rem", color: "#4ade80", fontWeight: "bold" }}>
            ✓ XRP reclamado
          </p>
          <code style={{ fontSize: "0.75rem", color: "#9ca3af", wordBreak: "break-all" }}>{reclaimTxid}</code>
        </div>
      )}
    </div>
  );
}
