'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Star, Award, Gift, TrendingUp, Trophy, ShoppingBag, RotateCcw, RefreshCw, Sparkles, Tag } from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth } from '@/lib/store';

// MLB-NEW WORKER 16: catalogo de razoes de transacoes loyalty -> icone + label legivel
const REASON_INFO: Record<string, { icon: any; label: string; color: string }> = {
  welcome_bonus:        { icon: Sparkles,    label: 'Bonus de boas-vindas',     color: 'text-magenta-glow' },
  order_paid:           { icon: ShoppingBag, label: 'Compra paga',              color: 'text-green-400' },
  order_redeem:         { icon: Tag,         label: 'Pontos resgatados',        color: 'text-orange-300' },
  order_refunded:       { icon: RotateCcw,   label: 'Pontos estornados',        color: 'text-red-400' },
  order_refund_restore: { icon: RefreshCw,   label: 'Pontos devolvidos',        color: 'text-cyan-300' },
};
function reasonInfo(reason: string) {
  return REASON_INFO[reason] || { icon: Gift, label: reason.replace(/_/g, ' '), color: 'text-white/60' };
}

const TIER_INFO: Record<string, { name: string; color: string; gradient: string; min: number; next?: number }> = {
  starter:  { name: 'Starter',  color: 'text-gray-300',   gradient: 'from-gray-500 to-gray-600',   min: 0,    next: 500 },
  gold:     { name: 'Gold',     color: 'text-yellow-300', gradient: 'from-yellow-500 to-orange-500', min: 500,  next: 3000 },
  platinum: { name: 'Platinum', color: 'text-cyan-300',   gradient: 'from-cyan-400 to-magenta',    min: 3000 },
};

export default function PontosPage() {
  const router = useRouter();
  const { token } = useAuth();
  const [data, setData] = useState<any>(null);
  const [limit, setLimit] = useState(20);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    if (!token) { router.push('/login'); return; }
    Api.api<any>(`/loyalty/me?limit=${limit}`, { auth: token, cache: 'no-store' })
      .then(setData)
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  }, [token, limit]);

  function loadMore() {
    setLoadingMore(true);
    setLimit((l) => l + 20);
  }

  if (!data) return <div className="container mx-auto px-6 py-16 text-center text-white/60">Carregando...</div>;
  const loyalty = data.loyalty;
  const transactions = data.transactions || [];
  const tier = TIER_INFO[loyalty.tier] || TIER_INFO.starter;
  const progressPct = tier.next
    ? Math.min(100, ((Number(loyalty.points_lifetime) - tier.min) / (tier.next - tier.min)) * 100)
    : 100;

  return (
    <div className="container mx-auto px-6 py-8 max-w-3xl">
      <Link href="/conta" className="text-sm text-white/60 hover:text-white">&larr; Voltar para conta</Link>

      {/* FIX-WORKER-15 pass 2: text-3xl em mobile (era 4xl wrapping em 375px) */}
      <h1 className="font-display font-bold text-3xl sm:text-4xl mt-4 mb-2">CAS Pontos</h1>
      <p className="text-white/60 mb-8 text-sm sm:text-base">Ganhe pontos a cada compra e troque por descontos exclusivos</p>

      {/* FIX-WORKER-15 pass 2: p-6 sm:p-8 + flex-col sm:flex-row evita colisao em 375px */}
      <div className={`glass-strong p-6 sm:p-8 mb-6 bg-gradient-to-br ${tier.gradient} bg-opacity-10`}>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 sm:gap-2 mb-4">
          <div>
            <div className={`text-xs uppercase font-bold ${tier.color}`}>Tier atual</div>
            <div className="font-display font-bold text-2xl sm:text-3xl flex items-center gap-2 mt-1">
              {tier.name === 'Platinum' && <Trophy className="w-6 h-6 sm:w-7 sm:h-7 text-cyan-300" />}
              {tier.name === 'Gold' && <Award className="w-6 h-6 sm:w-7 sm:h-7 text-yellow-300" />}
              {tier.name === 'Starter' && <Star className="w-6 h-6 sm:w-7 sm:h-7 text-gray-300" />}
              {tier.name}
            </div>
          </div>
          {/* FIX-WORKER-15 pass 2: text-left em mobile (proximo do tier), right em sm+ */}
          <div className="text-left sm:text-right">
            <div className="text-xs text-white/60">Saldo disponivel</div>
            {/* FIX-WORKER-15 pass 2: text-4xl em mobile (era 5xl overflow risk) */}
            <div className="font-display font-bold text-4xl sm:text-5xl text-magenta-glow">{Number(loyalty.points_balance).toLocaleString('pt-BR')}</div>
            <div className="text-xs text-white/40 mt-1">pontos</div>
          </div>
        </div>

        {tier.next && (
          <div>
            <div className="flex justify-between text-xs text-white/60 mb-1">
              <span>Progresso para proximo tier</span>
              <span className="font-mono">{loyalty.points_lifetime} / {tier.next}</span>
            </div>
            <div className="h-3 bg-white/10 rounded-full overflow-hidden">
              <div className={`h-full bg-gradient-to-r ${tier.gradient} transition-all duration-1000`} style={{ width: `${progressPct}%` }} />
            </div>
            <div className="text-xs text-white/50 mt-2">
              Faltam <strong className="text-white">{(tier.next - Number(loyalty.points_lifetime)).toLocaleString('pt-BR')}</strong> pontos para o tier {Object.values(TIER_INFO).find(t => t.min === tier.next)?.name}
            </div>
          </div>
        )}
      </div>

      <div className="grid md:grid-cols-3 gap-4 mb-8 text-center">
        <div className="glass p-4">
          <Gift className="w-8 h-8 mx-auto text-magenta mb-2" />
          <div className="text-sm font-semibold">+1 ponto por R$ 1</div>
          <div className="text-xs text-white/50">a cada compra paga</div>
        </div>
        <div className="glass p-4">
          <TrendingUp className="w-8 h-8 mx-auto text-magenta mb-2" />
          <div className="text-sm font-semibold">Gold: +20% pontos</div>
          <div className="text-xs text-white/50">a partir de 500 pts vitalicios</div>
        </div>
        <div className="glass p-4">
          <Trophy className="w-8 h-8 mx-auto text-magenta mb-2" />
          <div className="text-sm font-semibold">Platinum: +50%</div>
          <div className="text-xs text-white/50">a partir de 3.000 pts vitalicios</div>
        </div>
      </div>

      <div className="glass p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display font-bold text-xl">Extrato de pontos</h2>
          <span className="text-xs text-white/40">{transactions.length} transac{transactions.length === 1 ? 'ao' : 'oes'}</span>
        </div>
        {transactions.length === 0 ? (
          <p className="text-white/60 text-center py-8">Nenhuma transacao ainda. Faca uma compra para comecar a ganhar pontos!</p>
        ) : (
          <>
            {/* MLB-NEW WORKER 16: lista com icone + label legivel + cor por categoria */}
            <div className="divide-y divide-white/5">
              {transactions.map((t: any) => {
                const info = reasonInfo(t.reason);
                const Icon = info.icon;
                const earned = t.points_delta > 0;
                return (
                  <div key={t.id} className="flex items-center gap-3 py-3">
                    <div className={`w-9 h-9 flex-shrink-0 rounded-full bg-white/5 flex items-center justify-center ${info.color}`}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold truncate">{info.label}</div>
                      <div className="text-[11px] text-white/40">
                        {new Date(t.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
                        {t.reference_type && t.reference_id && (
                          <span className="ml-2 font-mono text-white/30">ref: {t.reference_id.slice(0,8)}</span>
                        )}
                      </div>
                    </div>
                    <div className={`font-display font-bold text-base whitespace-nowrap ${earned ? 'text-green-400' : 'text-red-400'}`}>
                      {earned ? '+' : ''}{t.points_delta} <span className="text-xs font-normal text-white/40">pts</span>
                    </div>
                  </div>
                );
              })}
            </div>
            {/* MLB-NEW WORKER 16: ver mais paginacao (sempre tenta se chegou no limit) */}
            {transactions.length >= limit && (
              <div className="mt-4 text-center">
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="px-4 py-2 rounded-lg border border-white/15 bg-white/5 text-sm hover:bg-white/10 transition-colors disabled:opacity-50"
                >
                  {loadingMore ? 'Carregando...' : 'Ver mais transacoes'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
