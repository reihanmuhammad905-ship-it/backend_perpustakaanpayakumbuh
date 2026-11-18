-- PULEN ONLY - pilot local. Safe to run again. No MyKopay schema changes.
BEGIN;
CREATE TABLE IF NOT EXISTS public.pulen_queue_offers (
  id BIGSERIAL PRIMARY KEY,
  queue_id INTEGER NOT NULL REFERENCES public.queue(id) ON DELETE CASCADE,
  book_id INTEGER NOT NULL REFERENCES public.books(id),
  user_id INTEGER NOT NULL REFERENCES public.users(id),
  status VARCHAR(24) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','claimed','expired','cancelled')),
  offered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  UNIQUE (queue_id)
);
CREATE INDEX IF NOT EXISTS ix_pulen_active_offer_by_book
  ON public.pulen_queue_offers(book_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS ix_pulen_offer_expiry
  ON public.pulen_queue_offers(expires_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS ix_pulen_offer_user
  ON public.pulen_queue_offers(user_id, status, expires_at);

-- Reuse existing PULEN inbox so old loan/queue notices and new offer notices
-- appear in one place. Extra columns are backwards compatible.
CREATE TABLE IF NOT EXISTS public.notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  title VARCHAR(180) NOT NULL,
  message TEXT NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS book_id INTEGER REFERENCES public.books(id),
  ADD COLUMN IF NOT EXISTS queue_id INTEGER REFERENCES public.queue(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS offer_id BIGINT REFERENCES public.pulen_queue_offers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS ix_pulen_notifications_user
  ON public.notifications(user_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_pulen_queue_offer_notification
  ON public.notifications(offer_id, type)
  WHERE offer_id IS NOT NULL AND type = 'queue_offer';
COMMIT;
