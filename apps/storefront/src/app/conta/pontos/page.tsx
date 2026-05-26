'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Star, Award, Gift, TrendingUp, Trophy } from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth } from '@/lib/store';

const TIER_INFO: Record<string, { name: string; color: string; gradient: string; min: number; next?: number }> = {
  starter:  { name: 'Starter',  color: 'text-gray-300',   gradient: 'from-gray-500 to-gray-600',   min: 0,    next: 500 },
  gold:     { name: 'Gold',     color: 'text-yellow-300', gradient: 'from-yellow-500 to-orange-500', min: 500,  next: 3000 },
  platinum: { name: 'Platinum', color: 'text-cyan-300',   gradient: 'from-cyan-400 to-magenta',    min: 3000 },
};

export default function PontosPage() {
  const router = useRouter();
  const { token } = useAuth();
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    if (!token) { router.push('/login'); return; }
    Api.api<any>('/loyalty/me', { auth: token, cache: 'no-store' })
      .then(setData)
      .catch(() => {});
  }, [token]);

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

      <h1 className="font-display font-bold text-4xl mt-4 mb-2">CAS Pontos</h1>
      <p className="text-white/60 mb-8">Ganhe pontos a cada compra e troque por descontos exclusivos</p>

      <div className={`glass-strong p-8 mb-6 bg-gradient-to-br ${tier.gradient} bg-opacity-10`}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className={`text-xs uppercase font-bold ${tier.color}`}>Tier atual</div>
            <div className="font-display font-bold text-3xl flex items-center gap-2 mt-1">
              {tier.name === 'Platinum' && <Trophy className="w-7 h-7 text-cyan-300" />}
              {tier.name === 'Gold' && <Award className="w-7 h-7 text-yellow-300" />}
              {tier.name === 'Starter' && <Star className="w-7 h-7 text-gray-300" />}
              {tier.name}
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs text-white/60">Saldo disponivel</div>
            <div className="font-display font-bold text-5xl text-magenta-glow">{Number(loyalty.points_balance).toLocaleString('pt-BR')}</div>
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
        <h2 className="font-display font-bold text-xl mb-4">Historico de pontos</h2>
        {transactions.length === 0 ? (
          <p className="text-white/60 text-center py-8">Nenhuma transacao ainda. Faca uma compra para comecar a ganhar pontos!</p>
        ) : (
          <div className="space-y-2">
            {transactions.map((t: any) => (
              <div key={t.id} className="flex items-center justify-between p-3 rounded bg-white/5">
                <div>
                  <div className="text-sm font-semibold capitalize">{t.reason.replace(/_/g, ' ')}</div>
                  <div className="text-xs text-white/40">{new Date(t.created_at).toLocaleString('pt-BR')}</div>
                </div>
                <div className={`font-display font-bold ${t.points_delta > 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {t.points_delta > 0 ? '+' : ''}{t.points_delta}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
