'use client';

import { useState, useEffect, useRef } from 'react';
import { Share2, Copy, Check, MessageCircle, Twitter, Linkedin } from 'lucide-react';

/**
 * MLB-13 WORKER 16 pass 127: Share Button no PDP.
 * Pattern Mercado Livre - botao discreto que abre menu com:
 *  - WhatsApp (deep link wa.me)
 *  - X/Twitter (intent URL)
 *  - LinkedIn (share API)
 *  - Copiar link (clipboard API + fallback)
 *
 * UTM tracking automatico: utm_source=share&utm_medium={channel}
 * para attribution analytics em search_log/product_views.
 *
 * Privacy/UX:
 *  - Tenta navigator.share() (Web Share API) em mobile primeiro
 *  - Fallback dropdown desktop
 *  - Click-outside fecha menu
 *  - Esc fecha menu
 */
export function ShareButton({ title, productSlug, productId: _productId }: {
  title: string;
  productSlug: string;
  productId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // FIX-WORKER-16 pass 127: build URL c/ UTM tracking per channel
  function urlWith(channel: string): string {
    if (typeof window === 'undefined') return '';
    const base = `${window.location.origin}/product/${productSlug}`;
    const params = new URLSearchParams({
      utm_source: 'share',
      utm_medium: channel,
      utm_campaign: 'product_share',
    });
    return `${base}?${params.toString()}`;
  }

  async function handleShareClick() {
    // FIX-WORKER-16 pass 127: try Web Share API (native UX em mobile)
    if (typeof navigator !== 'undefined' && (navigator as any).share) {
      try {
        await (navigator as any).share({
          title: `${title} - Code & Agent Shop`,
          text: `Confira ${title} na Code & Agent Shop`,
          url: urlWith('native'),
        });
        return; // sucesso native share - nao abre menu
      } catch (e: any) {
        if (e?.name === 'AbortError') return; // user cancelou - nao abre fallback
        // qualquer outro erro: fall through para menu desktop
      }
    }
    setOpen(!open);
  }

  async function handleCopy() {
    const url = urlWith('copy');
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        // fallback navegadores antigos
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => { setCopied(false); setOpen(false); }, 1500);
    } catch { /* silent - clipboard pode estar bloqueado */ }
  }

  // FIX-WORKER-16 pass 127 (a11y): Esc + click-outside fecham menu
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  const waText = encodeURIComponent(`Confira ${title} na Code & Agent Shop`);
  const xText = encodeURIComponent(`${title} | Code & Agent Shop`);

  return (
    <div ref={menuRef} className="relative inline-block">
      <button
        type="button"
        onClick={handleShareClick}
        aria-label="Compartilhar produto"
        aria-expanded={open}
        aria-haspopup="menu"
        className="w-full mt-3 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-white/10 hover:border-magenta/40 hover:bg-white/5 transition-colors text-sm focus-visible:outline-2 focus-visible:outline-magenta"
      >
        <Share2 className="w-4 h-4" aria-hidden="true" />
        Compartilhar
      </button>

      {open && (
        <div role="menu" aria-label="Compartilhar em redes sociais"
          className="absolute z-30 left-0 right-0 mt-2 glass-strong rounded-xl overflow-hidden shadow-2xl">
          <a
            role="menuitem"
            href={`https://wa.me/?text=${waText}%20${encodeURIComponent(urlWith('whatsapp'))}`}
            target="_blank" rel="noopener noreferrer"
            onClick={() => setOpen(false)}
            className="flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition-colors text-sm"
          >
            <MessageCircle className="w-4 h-4 text-green-400" aria-hidden="true" />
            <span>WhatsApp</span>
          </a>
          <a
            role="menuitem"
            href={`https://twitter.com/intent/tweet?text=${xText}&url=${encodeURIComponent(urlWith('twitter'))}`}
            target="_blank" rel="noopener noreferrer"
            onClick={() => setOpen(false)}
            className="flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition-colors text-sm border-t border-white/5"
          >
            <Twitter className="w-4 h-4 text-sky-400" aria-hidden="true" />
            <span>X (Twitter)</span>
          </a>
          <a
            role="menuitem"
            href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(urlWith('linkedin'))}`}
            target="_blank" rel="noopener noreferrer"
            onClick={() => setOpen(false)}
            className="flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition-colors text-sm border-t border-white/5"
          >
            <Linkedin className="w-4 h-4 text-blue-400" aria-hidden="true" />
            <span>LinkedIn</span>
          </a>
          <button
            role="menuitem"
            type="button"
            onClick={handleCopy}
            className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition-colors text-sm border-t border-white/5 text-left"
          >
            {copied ? (
              <Check className="w-4 h-4 text-green-400" aria-hidden="true" />
            ) : (
              <Copy className="w-4 h-4 text-magenta" aria-hidden="true" />
            )}
            <span>{copied ? 'Link copiado!' : 'Copiar link'}</span>
          </button>
        </div>
      )}
    </div>
  );
}
