-- MLB-12 (NEW): Sistema de "Avise-me se baixar" (price drop alert)
-- Equivalente do Mercado Livre "Quero ser avisado".
--
-- Tabela: product_price_alerts (user, product, threshold_cents, criado_em)
-- Trigger BEFORE UPDATE em products: se NEW.price_cents < OLD.price_cents,
-- insere notification para todos users com alert ativo (e threshold respeitado).
--
-- Idempotente: IF NOT EXISTS em tudo.

CREATE TABLE IF NOT EXISTS product_price_alerts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  -- threshold opcional: se NULL, notifica em qualquer queda. Se setado,
  -- so notifica quando preco <= threshold_cents
  threshold_cents bigint,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_notified_at timestamptz,
  UNIQUE (user_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_price_alerts_product
  ON product_price_alerts (product_id);
CREATE INDEX IF NOT EXISTS idx_price_alerts_user
  ON product_price_alerts (user_id, created_at DESC);

-- Trigger fn: dispara em UPDATE products quando price_cents desce
CREATE OR REPLACE FUNCTION fn_price_drop_notify()
RETURNS TRIGGER AS $$
DECLARE
  alert_rec RECORD;
BEGIN
  -- So age se preco baixou
  IF NEW.price_cents IS NULL OR OLD.price_cents IS NULL THEN RETURN NEW; END IF;
  IF NEW.price_cents >= OLD.price_cents THEN RETURN NEW; END IF;

  -- Notifica users com alerta ativo
  FOR alert_rec IN
    SELECT a.id, a.user_id, a.threshold_cents
      FROM product_price_alerts a
     WHERE a.product_id = NEW.id
       AND (a.threshold_cents IS NULL OR NEW.price_cents <= a.threshold_cents)
       -- Anti-spam: nao notifica se ja notificado nas ultimas 24h
       AND (a.last_notified_at IS NULL OR a.last_notified_at < NOW() - INTERVAL '24 hours')
  LOOP
    INSERT INTO notifications (
      user_id, channel, template_code, title, body, cta_url, payload, priority
    ) VALUES (
      alert_rec.user_id, 'in_app', 'price_drop',
      'Preco baixou no produto que voce queria!',
      format('Era R$ %s, agora R$ %s', (OLD.price_cents/100.0)::numeric(10,2), (NEW.price_cents/100.0)::numeric(10,2)),
      '/product/' || NEW.slug,
      jsonb_build_object('product_id', NEW.id, 'slug', NEW.slug, 'old_price_cents', OLD.price_cents, 'new_price_cents', NEW.price_cents),
      1
    );
    UPDATE product_price_alerts SET last_notified_at = NOW() WHERE id = alert_rec.id;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_products_price_drop') THEN
    CREATE TRIGGER trg_products_price_drop
      AFTER UPDATE OF price_cents ON products
      FOR EACH ROW
      EXECUTE FUNCTION fn_price_drop_notify();
  END IF;
END $$;
