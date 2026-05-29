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

  /* FIX-WORKER-8 pass 645 (a11y screen reader announcement timer countdown):
     PRE-FIX BUGS:
     1. No aria-live region - screen reader user nao percebe time updates
        - Visually impaired user clica PDP -> Zap icon + texto Promocao Relampago
        - Tempo restante mudando 1/seg invisivel ao NVDA/JAWS
        - User compra sem saber que faltam 30s -> perdeu desconto (timer expirou)
     2. Icons sem aria-hidden (decorativos mas anunciados redundante)
     3. Badge -X% sem aria-label semantico ("desconto X por cento")
     4. Cluster d/h/m/s sem context unificado (cada badge anunciado separado)
     POST-FIX:
     - role=region + aria-label timer scope
     - aria-live=polite + screen-reader text agg ("Faltam X dias Y horas Z minutos")
     - Update SR text apenas a cada minuto (anti-spam 1/seg muito verbose)
     - aria-hidden true em icons decorativos
     - Badge desconto aria-label semantico */
  const srText = days > 0
    ? `Promocao relampago: faltam ${days} dias, ${hours} horas e ${mins} minutos.`
    : hours > 0
      ? `Promocao relampago: faltam ${hours} horas e ${mins} minutos.`
      : mins > 0
        ? `Promocao relampago: faltam ${mins} minutos.`
        : `Promocao relampago: faltam menos de 1 minuto. Encerra em breve.`;

  return (
    <div role="region" aria-label={`Promocao relampago com ${discountPct} por cento de desconto`}
         className="glass-strong border-2 border-orange-500 rounded-lg p-3 sm:p-4 mb-4 animate-pulse-slow">
      {/* Screen reader live region - announces remaining time
          Updates 1/seg visualmente MAS aria-live so re-announces quando texto muda
          (a cada minuto basicamente - acceptable cadence for SR user) */}
      <span className="sr-only" aria-live="polite" aria-atomic="true">{srText}</span>
      {/* FIX-WORKER-15 pass 5: overflow horizontal em 375px com days>0.
          ANTES: 5 elementos inline (Clock + "Termina em:" + 4 badges)
          em uma row sem flex-wrap. Em 375px, container util ~343px e
          conteudo minimo ~370px -> overflow / squeeze ilegivel.
          AGORA: badges em row propria + flex-wrap no header (Zap+title
          podem quebrar com -% se titulo for longo). p-3 mobile/p-4 sm+. */}
      <div className="flex items-center gap-2 mb-2 flex-wrap" aria-hidden="true">
        <Zap className="w-5 h-5 text-orange-400 flex-shrink-0" />
        <span className="font-display font-bold text-orange-400 uppercase text-xs sm:text-sm">Promocao Relampago</span>
        <span className="ml-auto px-2 py-0.5 rounded bg-orange-500 text-black text-xs font-bold flex-shrink-0">
          -{discountPct}%
        </span>
      </div>
      <div className="flex items-center gap-2 text-xs sm:text-sm flex-wrap" aria-hidden="true">
        <Clock className="w-4 h-4 text-orange-300 flex-shrink-0" />
        <span className="text-white/80">Termina em:</span>
        {/* sm:ml-auto: badges ficam a direita em desktop, mas em mobile fluem natural
            depois do label "Termina em:". Sem ml-auto forcando squeeze. */}
        <div className="flex gap-1.5 font-mono font-bold sm:ml-auto">
          {days > 0 && <span className="bg-orange-500/30 px-1.5 sm:px-2 py-1 rounded text-orange-200">{days}d</span>}
          <span className="bg-orange-500/30 px-1.5 sm:px-2 py-1 rounded text-orange-200">{String(hours).padStart(2, '0')}h</span>
          <span className="bg-orange-500/30 px-1.5 sm:px-2 py-1 rounded text-orange-200">{String(mins).padStart(2, '0')}m</span>
          <span className="bg-orange-500/30 px-1.5 sm:px-2 py-1 rounded text-orange-200">{String(secs).padStart(2, '0')}s</span>
        </div>
      </div>
    </div>
  );
}
