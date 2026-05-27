'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, Clock, TrendingUp, Star, MessageCircle, ShoppingBag } from 'lucide-react';

// FIX-WORKER-8 pass 1: 2 bugs criticos:
// 1. Sem try-catch: fetch lanca em network error -> funcao rejeita ->
//    .then(setSomething) nunca chama -> loading state PERMANENTE em UI.
//    Seller via "Carregando..." infinito quando gateway down.
// 2. Regra B (W3 pass 1): r.json() sem await retornava Promise. JSON
//    malformed (HTML 503 gateway) rejeita fora -> unhandledRejection.
// FIX: try-catch wrap + await r.json() dentro.
async function fetchJSON(url: string) {
  const token = typeof window !== 'undefined' ? localStorage.getItem('cas_seller_token') : null;
  try {
    const r = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      credentials: 'include', cache: 'no-store',
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

const fmtBRL = (cents: number) => new Intl.NumberFormat('pt-BR', { style:'currency', currency:'BRL' }).format((cents||0)/100);

// Componente cronometro SLA Classe B
function SLACountdown({ deadline }: { deadline: string | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(i); }, []);
  if (!deadline) return null;
  const target = new Date(deadline).getTime();
  const diff = Math.max(0, target - now);
  const days = Math.floor(diff / (1000 * 3600 * 24));
  const hours = Math.floor((diff % (1000 * 3600 * 24)) / (1000 * 3600));
  const mins = Math.floor((diff % (1000 * 3600)) / (1000 * 60));
  const secs = Math.floor((diff % (1000 * 60)) / 1000);
  const danger = days <= 1;
  const warn = days <= 3;

  return (
    <div className={`glass p-6 border-2 ${danger ? 'border-red-500 animate-pulse-slow' : warn ? 'border-yellow-500' : 'border-white/10'}`}>
      <div className="flex items-center gap-3 mb-3">
        <Clock className={`w-6 h-6 ${danger ? 'text-red-400' : warn ? 'text-yellow-400' : 'text-magenta'}`} />
        <h3 className="font-display font-bold text-lg">SLA Classe B</h3>
      </div>
      <p className="text-sm text-white/60 mb-4">
        Tempo restante para o proximo upload aprovado. Caso vencer, suas API keys serao revogadas.
      </p>
      <div className="grid grid-cols-4 gap-2 text-center">
        {[
          { v: days, l: 'dias' }, { v: hours, l: 'horas' }, { v: mins, l: 'min' }, { v: secs, l: 'seg' }
        ].map((t, i) => (
          <div key={i} className="bg-black/30 rounded-lg p-3">
            <div className="font-display font-bold text-3xl font-mono">{String(t.v).padStart(2, '0')}</div>
            <div className="text-[10px] text-white/40 uppercase tracking-wider">{t.l}</div>
          </div>
        ))}
      </div>
      <Link href="/upload" className="btn-primary w-full mt-4 inline-block text-center">
        Enviar novo produto
      </Link>
    </div>
  );
}

export default function SellerHome() {
  const [me, setMe] = useState<any>(null);
  const [kpi, setKpi] = useState<any>(null);
  const [pending, setPending] = useState<any>({ qna_pending: 0, disputes_open: 0, products_in_qa: 0, products_rejected: 0 });
  const [sla, setSla] = useState<any>(null);

  useEffect(() => {
    fetchJSON('/api/sellers/me').then((r) => {
      if (r) {
        setMe(r.seller);
        setPending({
          qna_pending: r.seller?.qna_pending || 0,
          disputes_open: r.seller?.disputes_open || 0,
          products_in_qa: r.seller?.products_in_qa || 0,
          products_rejected: r.seller?.products_rejected || 0,
        });
      }
    });
    fetchJSON('/api/sellers/me/sla-status').then((r) => r && setSla(r.sla));
    fetchJSON('/api/sellers/me/kpi').then((r) => r && setKpi(r.kpi));
  }, []);

  return (
    <div>
      <h1 className="font-display font-bold text-4xl mb-2">
        Ola, <span className="text-magenta">{me?.store_name || 'vendedor'}</span>
      </h1>
      <p className="text-white/60 mb-8">
        Tier: <span className="px-2 py-0.5 rounded bg-magenta/20 text-magenta-glow text-xs">{me?.reputation_tier || '-'}</span>
        {' | '}Score: <span className="font-mono">{me?.reputation_score || 0}</span>
        {' | '}Vendas: <span className="font-mono">{me?.total_sales || 0}</span>
      </p>

      {/* Cronometro SLA Classe B (so aparece se Classe B + sla_active) */}
      {sla?.seller_class === 'class_b' && sla?.sla_active && (
        <div className="mb-8">
          <SLACountdown deadline={sla.sla_next_deadline_at} />
        </div>
      )}

      {/* Pendencias rapidas */}
      <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <Link href="/qna" className={`glass p-5 hover:scale-105 transition-transform ${pending.qna_pending > 0 ? 'border-yellow-500/50' : ''}`}>
          <MessageCircle className="w-7 h-7 text-magenta mb-3" />
          <div className="text-xs text-white/50 uppercase">Q&A pendente</div>
          <div className="font-display font-bold text-3xl">{pending.qna_pending}</div>
        </Link>
        <Link href="/products?status=qa_pending" className="glass p-5 hover:scale-105 transition-transform">
          <Clock className="w-7 h-7 text-magenta mb-3" />
          <div className="text-xs text-white/50 uppercase">Em QA</div>
          <div className="font-display font-bold text-3xl">{pending.products_in_qa}</div>
        </Link>
        <Link href="/products?status=rejected" className={`glass p-5 hover:scale-105 transition-transform ${pending.products_rejected > 0 ? 'border-red-500/50' : ''}`}>
          <AlertCircle className="w-7 h-7 text-red-400 mb-3" />
          <div className="text-xs text-white/50 uppercase">Rejeitados</div>
          <div className="font-display font-bold text-3xl">{pending.products_rejected}</div>
        </Link>
        <Link href="/financeiro" className="glass p-5 hover:scale-105 transition-transform">
          <TrendingUp className="w-7 h-7 text-magenta mb-3" />
          <div className="text-xs text-white/50 uppercase">Receita liquida</div>
          <div className="font-display font-bold text-2xl text-magenta-glow">{fmtBRL(kpi?.net_payout_cents || 0)}</div>
        </Link>
      </div>

      {/* KPIs detalhados */}
      <div className="grid md:grid-cols-3 gap-6">
        <div className="glass p-6">
          <div className="text-xs text-white/50 uppercase mb-2">Produtos ativos</div>
          <div className="font-display font-bold text-4xl">{kpi?.products_active || 0}</div>
        </div>
        <div className="glass p-6">
          <div className="text-xs text-white/50 uppercase mb-2 flex items-center gap-2"><Star className="w-3 h-3" /> Avaliacao media</div>
          <div className="font-display font-bold text-4xl">{kpi?.avg_rating ? Number(kpi.avg_rating).toFixed(1) : '-'}</div>
          <div className="text-xs text-white/40 mt-1">{kpi?.review_count || 0} reviews</div>
        </div>
        <div className="glass p-6">
          <div className="text-xs text-white/50 uppercase mb-2 flex items-center gap-2"><ShoppingBag className="w-3 h-3" /> Total pedidos</div>
          <div className="font-display font-bold text-4xl">{kpi?.total_orders || 0}</div>
        </div>
      </div>
    </div>
  );
}
