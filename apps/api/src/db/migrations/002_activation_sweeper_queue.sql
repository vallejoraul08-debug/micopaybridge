-- El sweeper de activación vivía solo en memoria: un Map que Railway
-- vaciaba en cada redeploy o reinicio, dejando escrows sin reclamar hasta
-- que el usuario volviera a apretar el botón a mano. Esta tabla es lo que
-- permite que sobreviva.
CREATE TABLE IF NOT EXISTS activation_sweeper_queue (
  owner          VARCHAR(56) NOT NULL,
  offer_sequence INTEGER NOT NULL,
  cancel_after   TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner, offer_sequence)
);
CREATE INDEX IF NOT EXISTS idx_activation_sweeper_cancel_after ON activation_sweeper_queue(cancel_after);
