'use client';

import { useEffect, useState } from 'react';
import { Zap, Clock } from 'lucide-react';

/**
 * Timer countdown para promocao relampago (MLB-10).
 * Atualiza a cada 1s. Quando expira, mostra "Encerrada".
 */
export function FlashPromoTimer({ endsAt, discountPct }: { endsAt: string; discountPct: number }) {
  const [remaining, setRemaining] = useState<number>(() =>
    Math.max(0, Math.floor((new Date(endsAt).getTime() - Date.now()) / 1000))
  );

  useEffect(() => {
    const target = new Date(endsAt).getTime();
    const i = setInterval(() => {
      setRemaining(Math.max(0, Math.floor((target - Date.now()) / 1000)));
    }, 1000);
    return () => clearInterval(i);
  }, [endsAt]);

  if (remaining <= 0) return null;

  const days = Math.floor(remaining / 86400);
  const hours = Math.floor((remaining % 86400) / 3600);
  const mins = Math.floor((remaining % 3600) / 60);
  const secs = remaining % 60;

  return (
    <div className="glass-strong border-2 border-orange-500 rounded-lg p-4 mb-4 animate-pulse-slow">
      <div className="flex items-center gap-2 mb-2">
        <Zap className="w-5 h-5 text-orange-400" />
        <span className="font-display font-bold text-orange-400 uppercase text-sm">Promocao Relampago</span>
        <span className="ml-auto px-2 py-0.5 rounded bg-orange-500 text-black text-xs font-bold">
          -{discountPct}%
        </span>
      </div>
      <div className="flex items-center gap-2 text-sm">
        <Clock className="w-4 h-4 text-orange-300" />
        <span className="text-white/80">Termina em:</span>
        <div className="ml-auto flex gap-1.5 font-mono font-bold">
          {days > 0 && <span className="bg-orange-500/30 px-2 py-1 rounded text-orange-200">{days}d</span>}
          <span className="bg-orange-500/30 px-2 py-1 rounded text-orange-200">{String(hours).padStart(2, '0')}h</span>
          <span className="bg-orange-500/30 px-2 py-1 rounded text-orange-200">{String(mins).padStart(2, '0')}m</span>
          <span className="bg-orange-500/30 px-2 py-1 rounded text-orange-200">{String(secs).padStart(2, '0')}s</span>
        </div>
      </div>
    </div>
  );
}
