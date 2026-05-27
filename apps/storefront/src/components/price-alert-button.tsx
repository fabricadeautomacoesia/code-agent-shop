'use client';

/**
 * MLB-12 (NEW): Botao "Avise-me se baixar" no PDP.
 *
 * - Sem auth: redireciona para /login com return URL
 * - Auth: POST /products/price-alerts (toggle ativacao)
 * - State: active/inactive baseado em check inicial
 *
 * UX similar ao Mercado Livre "Quero ser avisado quando baixar".
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, BellRing } from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth } from '@/lib/store';

interface Props {
  productId: string;
  currentPriceCents: number;
}

export function PriceAlertButton({ productId, currentPriceCents }: Props) {
  const router = useRouter();
  const { token } = useAuth();
  const [active, setActive] = useState(false);
  const [loading, setLoading] = useState(false);

  // Check estado inicial (lista alertas, filtra por productId)
  useEffect(() => {
    if (!token) return;
    Api.api<{ alerts: any[] }>('/products/price-alerts', { auth: token })
      .then((r) => setActive(r.alerts.some((a) => a.product_id === productId)))
      .catch(() => {});
  }, [token, productId]);

  async function toggle() {
    if (!token) {
      router.push(`/login?return=/product/${productId}`);
      return;
    }
    setLoading(true);
    try {
      if (active) {
        await Api.api(`/products/price-alerts/${productId}`, { method: 'DELETE', auth: token });
        setActive(false);
      } else {
        await Api.api('/products/price-alerts', {
          method: 'POST', auth: token,
          body: JSON.stringify({ product_id: productId }),
        });
        setActive(true);
      }
    } catch {} finally { setLoading(false); }
  }

  return (
    <button onClick={toggle} disabled={loading}
      className={`w-full px-4 py-2.5 rounded-lg border-2 text-sm font-medium transition-all disabled:opacity-50 ${
        active
          ? 'border-magenta bg-magenta/10 text-magenta-glow'
          : 'border-white/10 bg-white/5 hover:border-white/30 text-white/70'
      }`}
      title={active ? 'Voce sera notificado se o preco baixar' : 'Receber email se o preco baixar'}>
      <div className="flex items-center justify-center gap-2">
        {active ? <BellRing className="w-4 h-4" /> : <Bell className="w-4 h-4" />}
        <span>
          {loading ? '...' : (active ? 'Alerta ativo (clique para remover)' : 'Avise-me se o preco baixar')}
        </span>
      </div>
    </button>
  );
}
