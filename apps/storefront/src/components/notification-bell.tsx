'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Bell, X, Check, CheckCheck, ExternalLink } from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth } from '@/lib/store';

// FIX-WORKER-1: infere URL para template quando cta_url eh null (~99% das notifs hoje).
// Mercado Livre: sino sempre tem onde clicar -> reduz friccao + aumenta engajamento.
function inferCtaUrl(n: any): string | null {
  if (n.cta_url) return n.cta_url;
  const p = n.payload || {};
  switch (n.template_code) {
    case 'product_approved':
    case 'product_rejected':
      return p.slug ? `/product/${p.slug}` : '/conta';
    case 'product_new_version':
      return p.slug ? `/product/${p.slug}` : null;
    case 'order_paid':
    case 'order_fulfilled':
      return p.order_id ? `/conta/pedidos/${p.order_id}` : '/conta/pedidos';
    case 'product_qna_new':
    case 'product_qna_answered':
      return p.slug ? `/product/${p.slug}#qna` : null;
    case 'product_review_new':
      return p.slug ? `/product/${p.slug}#reviews` : null;
    case 'payout_approved':
    case 'payout_paid':
    case 'payout_rejected':
      return 'https://seller.cas.inovareinteligenciaartificial.com/financeiro';
    case 'welcome_bonus':
    case 'loyalty_tier_up':
      return '/conta/pontos';
    case 'wishlist_back_in_stock':
      return '/conta/favoritos';
    case 'test_bell':
      return '/conta';
    default:
      return null;
  }
}

/**
 * Sininho de notificacoes in_app. Polling a cada 60s.
 * Click no item marca como lida.
 */
export function NotificationBell() {
  const { token } = useAuth();
  const [open, setOpen] = useState(false);
  const [notifs, setNotifs] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  // FIX-WORKER-13 pass 4: count separado do payload completo. Poll 30s baixo custo
  // (16 bytes) vs 60s pesado (~15kb com 20 notifs). Notifs carregadas SO ao abrir.
  const [unreadCount, setUnreadCount] = useState(0);

  // Unread total: count separado (poll 30s) OU recalcula a partir das notifs ja carregadas
  const unread = notifs.length > 0
    ? notifs.filter((n) => !n.is_read).length
    : unreadCount;

  async function loadCount() {
    if (!token) return;
    try {
      const r = await Api.api<{ count: number }>('/notifications/unread-count', { auth: token });
      setUnreadCount(r.count || 0);
    } catch { /* silent */ }
  }

  async function load() {
    if (!token) return;
    setLoading(true);
    try {
      const r = await Api.api<{ notifications: any[] }>('/notifications?limit=20', { auth: token });
      setNotifs(r.notifications || []);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }

  useEffect(() => {
    if (!token) { setNotifs([]); setUnreadCount(0); return; }
    // FIX-WORKER-13 pass 4: so chama /unread-count no poll (16 bytes vs 15kb)
    loadCount();
    const i = setInterval(loadCount, 30000);  // poll mais frequente, custo baixo
    return () => clearInterval(i);
  }, [token]);

  // Quando abre o dropdown, ai sim carrega lista completa
  useEffect(() => {
    if (open && notifs.length === 0) load();
  }, [open]);

  async function markRead(id: string) {
    try {
      await Api.api(`/notifications/${id}/read`, { method: 'POST', auth: token! });
      setNotifs((p) => p.map((n) => n.id === id ? { ...n, is_read: true } : n));
      setUnreadCount((c) => Math.max(0, c - 1));
    } catch {}
  }

  // FIX-WORKER-1: marcar todas como lidas em uma acao
  async function markAllRead() {
    try {
      await Api.api(`/notifications/read-all`, { method: 'POST', auth: token! });
      setNotifs((p) => p.map((n) => ({ ...n, is_read: true })));
      setUnreadCount(0);
    } catch {}
  }

  if (!token) return null;

  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)}
        className="p-2 rounded-lg hover:bg-white/5 transition-colors relative">
        <Bell className="w-5 h-5" />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 bg-magenta text-white text-[10px] rounded-full w-5 h-5 flex items-center justify-center font-bold">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-12 z-50 w-96 max-w-[calc(100vw-2rem)] glass-strong rounded-xl overflow-hidden shadow-2xl">
            <header className="flex items-center justify-between p-4 border-b border-white/10">
              <h3 className="font-display font-bold">Notificacoes</h3>
              <div className="flex items-center gap-1">
                {unread > 0 && (
                  <button onClick={markAllRead}
                    className="px-2 py-1 text-[11px] rounded hover:bg-white/5 text-magenta hover:text-magenta-glow transition-colors flex items-center gap-1"
                    title="Marcar todas como lidas">
                    <CheckCheck className="w-3.5 h-3.5" />
                    Marcar todas
                  </button>
                )}
                <button onClick={() => setOpen(false)} className="p-1 hover:bg-white/5 rounded">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </header>

            <div className="max-h-96 overflow-y-auto">
              {loading && notifs.length === 0 ? (
                <div className="p-8 text-center text-white/40 text-sm">Carregando...</div>
              ) : notifs.length === 0 ? (
                <div className="p-8 text-center text-white/40 text-sm">
                  Nenhuma notificacao
                </div>
              ) : (
                notifs.map((n) => {
                  // FIX-WORKER-1: cta_url ou fallback por template -> wrap em Link clicavel.
                  const url = inferCtaUrl(n);
                  const isExternal = url?.startsWith('http');
                  const onClickItem = () => {
                    if (!n.is_read) markRead(n.id);
                    if (isExternal) setOpen(false); // external Link nao re-renderiza
                  };
                  const inner = (
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold truncate">{n.title}</div>
                        <div className="text-xs text-white/60 mt-1 line-clamp-2">{n.body}</div>
                        <div className="text-[10px] text-white/40 mt-1 flex items-center gap-1.5">
                          {new Date(n.created_at).toLocaleString('pt-BR')}
                          {url && <span className="text-magenta">- {n.cta_label || 'Abrir'} <ExternalLink className="w-2.5 h-2.5 inline" /></span>}
                        </div>
                      </div>
                      {n.is_read ? <CheckCheck className="w-3 h-3 text-white/30 flex-shrink-0" />
                                 : <Check className="w-3 h-3 text-magenta flex-shrink-0" />}
                    </div>
                  );
                  const cls = `block p-4 border-b border-white/5 cursor-pointer hover:bg-white/5 ${
                    !n.is_read ? 'bg-magenta/5 border-l-2 border-l-magenta' : ''
                  }`;
                  if (url && !isExternal) {
                    return <Link key={n.id} href={url} onClick={onClickItem} className={cls}>{inner}</Link>;
                  }
                  if (url && isExternal) {
                    return <a key={n.id} href={url} onClick={onClickItem} target="_blank" rel="noopener" className={cls}>{inner}</a>;
                  }
                  return <div key={n.id} onClick={onClickItem} className={cls}>{inner}</div>;
                })
              )}
            </div>

            {notifs.length > 0 && (
              <footer className="p-3 border-t border-white/10 text-center">
                <Link href="/conta" onClick={() => setOpen(false)} className="text-xs text-magenta hover:underline">
                  Ver todas em Minha Conta
                </Link>
              </footer>
            )}
          </div>
        </>
      )}
    </div>
  );
}
