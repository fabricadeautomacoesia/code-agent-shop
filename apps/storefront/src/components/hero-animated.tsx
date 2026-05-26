'use client';

import { useEffect, useRef } from 'react';
import gsap from 'gsap';

/**
 * Hero animado com cubos 3D flutuantes (V8 13 - render engine inspiration).
 * Pseudo-version: 6 cards translucent flutuando em rotacao CSS 3D + glow.
 */
export function HeroAnimated() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const cards = ref.current.querySelectorAll<HTMLElement>('.hero-card');

    // Animacao continua de flutuacao
    cards.forEach((card, i) => {
      gsap.to(card, {
        y: '-=20',
        rotation: '+=3',
        duration: 2 + i * 0.3,
        repeat: -1,
        yoyo: true,
        ease: 'sine.inOut',
        delay: i * 0.2,
      });
    });

    // Mouse parallax (V8 15.4 flashlight)
    const onMove = (e: MouseEvent) => {
      const rect = ref.current!.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width - 0.5;
      const y = (e.clientY - rect.top) / rect.height - 0.5;
      cards.forEach((card, i) => {
        gsap.to(card, {
          x: x * (10 + i * 5),
          rotationY: x * 15,
          rotationX: -y * 10,
          duration: 0.8,
          ease: 'power2.out',
        });
      });
    };
    ref.current.addEventListener('mousemove', onMove);
    return () => ref.current?.removeEventListener('mousemove', onMove);
  }, []);

  const cards = [
    { title: 'Agente IA',      sub: 'WhatsApp + RAG',   cls: 'top-0 left-12',     color: 'from-magenta to-violet-deep' },
    { title: 'n8n Workflow',   sub: 'CRM + Vendas',     cls: 'top-16 right-0',    color: 'from-violet-deep to-cyber-blue' },
    { title: 'Script Python',  sub: 'Trader Bot',       cls: 'top-40 left-0',     color: 'from-cyber-blue to-magenta' },
    { title: 'Prompt Pack',    sub: '50 prompts B2B',   cls: 'top-56 right-16',   color: 'from-magenta-glow to-magenta' },
  ];

  return (
    <div ref={ref} className="relative h-[480px] w-full" style={{ perspective: '1500px' }}>
      {cards.map((c, i) => (
        <div key={i} className={`hero-card absolute glass px-5 py-4 w-56 ${c.cls}`}
          style={{ transform: `translateZ(${i * 20}px)`, transformStyle: 'preserve-3d' }}>
          <div className={`h-1 w-12 rounded-full bg-gradient-to-r ${c.color} mb-3`} />
          <div className="font-display font-bold text-lg">{c.title}</div>
          <div className="text-xs text-white/60">{c.sub}</div>
          <div className="flex items-center gap-1 mt-3 text-[10px] font-mono text-white/40">
            <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            QA score 0.94
          </div>
        </div>
      ))}
      {/* Glow orb central */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="w-72 h-72 rounded-full bg-gradient-vibe opacity-20 blur-3xl animate-glow-pulse" />
      </div>
    </div>
  );
}
