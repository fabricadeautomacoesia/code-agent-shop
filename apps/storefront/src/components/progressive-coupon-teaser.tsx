'use client';

import { useEffect, useState } from 'react';
import { Tag, TrendingUp, Check, ArrowRight } from 'lucide-react';
import { Api } from '@/lib/api';

/**
 * MLB-NEW WORKER 16: widget proativo de cupom progressivo na cart.
 *
 * Mercado Livre exibe "Compre mais e ganhe descontos progressivos" ANTES de
 * o usuario aplicar qualquer cupom. Mostra escada de tiers + ja calcula o
 * desconto efetivo no subtotal atual + CTA "Aplicar agora" 1-click.
 *
 * Diferenca vs widget existente:
 *  - existente so renderiza APOS apply manual do cupom
 *  - este renderiza SEMPRE que ha um cupom progressivo publico ativo
 *  - foco: aumentar AOV (Average Order Value) mostrando proximo tier
 *
 * Skip render se:
 *  - cupom ja aplicado (evita duplicacao com widget existente)
 *  - subtotal=0 ou erro de fetch
 */
export function ProgressiveCouponTeaser({
  token,
  subtotalCents,
  alreadyApplied,
  onApplied,
  defaultCode = 'PROGRESSIVO15',
}: {
  token: string | null;
  subtotalCents: number;
  alreadyApplied: boolean;
  onApplied: () => void;
  defaultCode?: string;
}) {
  const [preview, setPreview] = useState<any>(null);
  const [applying, setApplying] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!token || !subtotalCents || alreadyApplied) { setPreview(null); return; }
    Api.api<any>(`/orders/cart/coupon/${defaultCode}/preview?subtotal_cents=${subtotalCents}`, {
      auth: token, cache: 'no-store',
    })
      .then((r) => setPreview(r))
      .catch(() => setPreview(null));
  }, [token, subtotalCents, alreadyApplied, defaultCode]);

  if (!preview || alreadyApplied || !preview.tiers?.length) return null;

  const active = preview.active_tier_index;
  const next = preview.next_tier;

  async function applyNow() {
    if (!token) return;
    setApplying(true);
    setErr('');
    try {
      await Api.cartCoupon(token, defaultCode);
      onApplied();
    } catch (e: any) {
      setErr(e?.data?.message || e?.message || 'Erro ao aplicar cupom');
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="rounded-lg border border-magenta/40 bg-gradient-to-br from-magenta/10 to-purple-500/5 p-3 mb-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 text-xs font-bold text-magenta-glow">
          <TrendingUp className="w-3.5 h-3.5" />
          GANHE DESCONTO PROGRESSIVO
        </div>
        <span className="text-[10px] font-mono bg-magenta/20 text-magenta-glow px-2 py-0.5 rounded">
          {defaultCode}
        </span>
      </div>

      <div className="space-y-1.5 mb-3">
        {preview.tiers.map((t: any, idx: number) => {
          const reached = subtotalCents >= Number(t.min_cents);
          const isActive = idx === active;
          return (
            <div key={idx} className={`flex justify-between items-center text-xs ${
              isActive ? 'text-white font-bold' : reached ? 'text-white/70' : 'text-white/40'
            }`}>
              <span className="flex items-center gap-1.5">
                {reached
                  ? <Check className="w-3 h-3 text-green-400" />
                  : <span className="w-3 h-3 rounded-full border border-white/30 inline-block" />}
                A partir de {Api.formatBRL(Number(t.min_cents))}
              </span>
              <span className={isActive ? 'text-magenta-glow font-mono' : 'font-mono'}>
                -{t.discount_value}{preview.coupon?.discount_type === 'percentage' ? '%' : ' R$'}
              </span>
            </div>
          );
        })}
      </div>

      {next && (
        <div className="text-[11px] text-white/60 mb-3 pb-2 border-b border-white/10">
          + <strong className="text-white">{Api.formatBRL(Number(next.min_cents) - subtotalCents)}</strong> para ganhar
          {' '}<strong className="text-magenta-glow">-{next.discount_value}{preview.coupon?.discount_type === 'percentage' ? '%' : ' R$'}</strong>
        </div>
      )}

      {active >= 0 ? (
        <button
          onClick={applyNow}
          disabled={applying}
          className="w-full px-3 py-2 rounded-lg bg-gradient-vibe text-white text-xs font-semibold hover:opacity-90 transition-opacity flex items-center justify-center gap-1.5 disabled:opacity-50"
        >
          <Tag className="w-3.5 h-3.5" />
          {applying ? 'Aplicando...' : `Aplicar -${Api.formatBRL(preview.discount_cents || 0)} agora`}
          {!applying && <ArrowRight className="w-3.5 h-3.5" />}
        </button>
      ) : (
        <div className="text-center text-[11px] text-white/40 py-1">
          Atinja o primeiro tier para liberar o desconto
        </div>
      )}

      {err && <div className="text-[11px] text-red-400 mt-2">{err}</div>}
    </div>
  );
}
