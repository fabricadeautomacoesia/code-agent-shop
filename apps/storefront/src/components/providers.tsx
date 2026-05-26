'use client';

import { useEffect } from 'react';
import Lenis from 'lenis';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

if (typeof window !== 'undefined') gsap.registerPlugin(ScrollTrigger);

export function Providers({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    // Error boundary global (V8 23.3)
    const onErr = (e: ErrorEvent) => { console.error('[Fatal]', e.message); e.preventDefault(); };
    const onRej = (e: PromiseRejectionEvent) => { console.error('[Promise]', e.reason); e.preventDefault(); };
    window.addEventListener('error', onErr);
    window.addEventListener('unhandledrejection', onRej);

    // Lenis smooth scroll (V8 23.8)
    const lenis = new Lenis({ duration: 1.2, smoothWheel: true });
    const raf = (time: number) => { lenis.raf(time); requestAnimationFrame(raf); };
    requestAnimationFrame(raf);

    // GSAP reveal-up auto on scroll
    const els = document.querySelectorAll<HTMLElement>('.reveal-up');
    els.forEach((el) => {
      ScrollTrigger.create({
        trigger: el, start: 'top 85%',
        onEnter: () => el.classList.add('in'),
      });
    });

    return () => {
      window.removeEventListener('error', onErr);
      window.removeEventListener('unhandledrejection', onRej);
      lenis.destroy();
    };
  }, []);

  return <>{children}</>;
}
