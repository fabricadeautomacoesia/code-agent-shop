'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Bell, X, Check, CheckCheck, ExternalLink } from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth } from '@/lib/store';

// FIX-WORKER-1 pass 355: env-driven seller dashboard URL
//   PRE-FIX: 'https://seller.cas.inovareinteligenciaartificial.com/financeiro' hardcoded
//   - deploy/stack.yml alternativo usa seller.code-agent-shop.com.br
//   - Dev environments e custom deployments precisam override sem rebuild
//   - Mudanca de domain em prod = re-build storefront (lento - 8-12min)
//   POST-FIX: NEXT_PUBLIC_SELLER_URL env-driven + fallback Traefik host ativo
//   (stack.inovare.yml). Deploy controla via env -> tempo zero pra mudar.
const SELLER_DASH_URL = process.env.NEXT_PUBLIC_SELLER_URL ||
  'https://seller.cas.inovareinteligenciaartificial.com';

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
    // FIX-WORKER-1 pass 434 (deep-link hash consume pass 426 product-tabs handler):
    //   PRE-FIX: '#qna' / '#reviews' (sem dash + id)
    //   - product-tabs.tsx pass 426 useEffect checa hash.startsWith('qna-')
    //   - '#qna' NUNCA matches '#qna-{uuid}' regex -> tab nao switchava
    //   - User clicava notif -> abria PDP em 'overview' tab (perdia contexto)
    //   POST-FIX: payload.qna_id (backend pass 434) -> #qna-{uuid}
    //   Combined com product-tabs hash handler -> auto-switch tab + scroll.
    //   Fallback gracioso: se qna_id null (notifs legacy pre-pass-434), usa
    //   '#qna-' (matches startsWith mas sem scroll target - tab switch only).
    case 'product_qna_new':
    case 'product_qna_answered':
      if (!p.slug) return null;
      return p.qna_id ? `/product/${p.slug}#qna-${p.qna_id}` : `/product/${p.slug}#qna-`;
    case 'product_review_new':
      if (!p.slug) return null;
      return p.review_id ? `/product/${p.slug}#review-${p.review_id}` : `/product/${p.slug}#review-`;
    case 'payout_approved':
    case 'payout_paid':
    case 'payout_rejected':
      return `${SELLER_DASH_URL}/financeiro`;
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
      const list = r.notifications || [];
      setNotifs(list);
      // FIX-WORKER-1 pass 2: sincronizar count com payload real ao abrir.
      // Evita drift quando poll /unread-count fica desatualizado vs lista.
      setUnreadCount(list.filter((n: any) => !n.is_read).length);
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
  // FIX-WORKER-1 pass 2: bug stale notifs - guarda `notifs.length === 0`
  // impedia refetch ao reabrir. Cenario quebrado:
  // 1. User abre sino, ve 5 notifs (load roda)
  // 2. Fecha sem marcar nenhuma como lida
  // 3. Backend cria 2 novas notifs (welcome_bonus + product_approved)
  // 4. unread badge atualiza para 7 (via loadCount poll 30s) - OK
  // 5. Mas reabrir o sino mostra so as 5 antigas (notifs.length>0 -> skip load)
  // Agora: refetch sempre que open=true. token nos deps p/ eslint correctness.
  useEffect(() => {
    if (open) load();
  }, [open, token]);

  // FIX-WORKER-3 pass 7: optimistic update + rollback em erro (pattern
  // WishlistButton pass 4 + PriceAlertButton pass 6).
  // ANTES: setState APOS await OK -> dessincronizacao state vs DB se 500/network.
  //        catch{} silent -> notif aparecia "lida" no UI mas backend nao marcou.
  //        Proximo poll /unread-count sobrescrevia count correto, mas notifs list
  //        ficava errada ate fechar/abrir. Dessincronizacao confusa.
  // AGORA: flip imediato + rollback se falhar.
  async function markRead(id: string) {
    // FIX-WORKER-1 pass 267 (defensive UUID + observable failure):
    //   PRE-FIX: id direto na URL sem validate, catch {} silent
    //   - id malformed (backend shape drift) -> GET /notifications/undefined/read 404
    //   - catch swallow -> user nunca via erro mas optimistic flip ja aconteceu
    //   - Resultado: badge unread diz "0" mas DB tem unread - dessync silencioso
    //   POST-FIX: UUID v4 regex client-side + log.error em failures
    //   (browser console - admin debug forensics)
    const UUID_RE_CLIENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!id || !UUID_RE_CLIENT.test(id)) {
      console.error('[notification-bell] markRead invalid id', { id });
      return;
    }
    // snapshot pre-mutate (para rollback)
    const target = notifs.find((n) => n.id === id);
    if (!target || target.is_read) return; // ja lido = no-op
    // optimistic flip imediato
    setNotifs((p) => p.map((n) => n.id === id ? { ...n, is_read: true } : n));
    setUnreadCount((c) => Math.max(0, c - 1));
    try {
      await Api.api(`/notifications/${id}/read`, { method: 'POST', auth: token! });
    } catch (e: any) {
      // rollback - restaura is_read=false e incrementa unread
      console.error('[notification-bell] markRead failed - rolling back', { id, err: e?.message });
      setNotifs((p) => p.map((n) => n.id === id ? { ...n, is_read: false } : n));
      setUnreadCount((c) => c + 1);
    }
  }

  // FIX-WORKER-1: marcar todas como lidas em uma acao
  // FIX-WORKER-3 pass 7: optimistic + rollback (mesmo pattern markRead acima)
  async function markAllRead() {
    // snapshot pre-mutate
    const prevNotifs = notifs;
    const prevCount = unreadCount;
    // optimistic flip imediato (UX instantanea)
    setNotifs((p) => p.map((n) => ({ ...n, is_read: true })));
    setUnreadCount(0);
    try {
      await Api.api(`/notifications/read-all`, { method: 'POST', auth: token! });
    } catch {
      // rollback - restaura snapshot completo
      setNotifs(prevNotifs);
      setUnreadCount(prevCount);
    }
  }

  // FIX-WORKER-3 pass 7 (a11y): Escape key fecha dropdown (keyboard users)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!token) return null;

  // FIX-WORKER-3 pass 7 (a11y): aria-label dinamico com contagem + aria-expanded
  // + aria-haspopup. Antes: screen readers anunciavam apenas "botao" sem contexto.
  const bellLabel = unread > 0
    ? `Notificacoes: ${unread} nao lida${unread === 1 ? '' : 's'}`
    : 'Notificacoes';

  return (
    <div className="relative">
      {/* FIX-WORKER-1 pass 160 (a11y): type='button' defensive (V8 Regra 23) */}
      <button type="button" onClick={() => setOpen(!open)}
        aria-label={bellLabel}
        aria-expanded={open}
        aria-haspopup="menu"
        className="p-2 rounded-lg hover:bg-white/5 transition-colors relative focus-visible:outline-2 focus-visible:outline-magenta">
        <Bell className="w-5 h-5" aria-hidden="true" />
        {unread > 0 && (
          <span aria-hidden="true"
            className="absolute -top-1 -right-1 bg-magenta text-white text-[10px] rounded-full w-5 h-5 flex items-center justify-center font-bold">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <>
          {/* FIX-WORKER-1 pass 160 (a11y): backdrop button p/ keyboard close (Esc tambem funciona).
              role='presentation' p/ SR ignorar (decorativo - X visivel atende UX). */}
          <button type="button" aria-label="Fechar notificacoes"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)} />
          <div role="menu" aria-label="Notificacoes"
            className="absolute right-0 top-12 z-50 w-96 max-w-[calc(100vw-2rem)] glass-strong rounded-xl overflow-hidden shadow-2xl">
            <header className="flex items-center justify-between p-4 border-b border-white/10">
              <h3 className="font-display font-bold">Notificacoes</h3>
              <div className="flex items-center gap-1">
                {unread > 0 && (
                  /* FIX-WORKER-1 pass 160: type='button' + aria-label dinamico count */
                  <button type="button" onClick={markAllRead}
                    aria-label={`Marcar todas as ${unread} notificacoes como lidas`}
                    className="px-2 py-1 text-[11px] rounded hover:bg-white/5 text-magenta hover:text-magenta-glow transition-colors flex items-center gap-1 focus-visible:outline-2 focus-visible:outline-magenta"
                    title="Marcar todas como lidas">
                    <CheckCheck className="w-3.5 h-3.5" aria-hidden="true" />
                    Marcar todas
                  </button>
                )}
                <button type="button" onClick={() => setOpen(false)}
                  aria-label="Fechar painel de notificacoes"
                  className="p-1 hover:bg-white/5 rounded focus-visible:outline-2 focus-visible:outline-magenta">
                  <X className="w-4 h-4" aria-hidden="true" />
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
                          {/* FIX-WORKER-1 pass 306: defensive date guard paridade pass 254/283
                              created_at null/invalid -> "Invalid Date" UX feio.
                              POST-FIX: !isNaN check + fallback '-'. */}
                          {n.created_at && !isNaN(new Date(n.created_at).getTime())
                            ? new Date(n.created_at).toLocaleString('pt-BR')
                            : '-'}
                          {url && <span className="text-magenta">- {n.cta_label || 'Abrir'} <ExternalLink className="w-2.5 h-2.5 inline" /></span>}
                        </div>
                      </div>
                      {/* FIX-WORKER-1 pass 653 (a11y - decorative icons aria-hidden):
                          PRE-FIX: CheckCheck/Check icons SEM aria-hidden anunciados redundante
                          por SR junto com title/body text + aria-label "lida/nao lida" externo.
                          NVDA/JAWS lia "CheckCheck Notification title... lida"
                          (icon name expandido pelo accessible-name parser sem hidden flag).
                          Paridade cadeia 8+ icons aria-hidden cross-components (passes 159/186/541/575/645).
                          POST-FIX: + aria-hidden=true (icons decorativos - estado ja em aria-label). */}
                      {n.is_read ? <CheckCheck className="w-3 h-3 text-white/30 flex-shrink-0" aria-hidden="true" />
                                 : <Check className="w-3 h-3 text-magenta flex-shrink-0" aria-hidden="true" />}
                    </div>
                  );
                  const cls = `block p-4 border-b border-white/5 cursor-pointer hover:bg-white/5 ${
                    !n.is_read ? 'bg-magenta/5 border-l-2 border-l-magenta' : ''
                  }`;
                  if (url && !isExternal) {
                    return <Link key={n.id} href={url} onClick={onClickItem} className={cls}>{inner}</Link>;
                  }
                  if (url && isExternal) {
                    // FIX-WORKER-1 pass 230 (tabnabbing defense): rel="noopener" sozinho
                    // protege window.opener mas browsers legados/Safari < 13 vazam referrer.
                    // Pattern checkout pass 6: sempre "noopener noreferrer" em external links.
                    return <a key={n.id} href={url} onClick={onClickItem} target="_blank" rel="noopener noreferrer" className={cls}>{inner}</a>;
                  }
                  // FIX-WORKER-3 pass 7 (a11y): div onClick sem url -> role=button +
                  // tabIndex + onKeyDown Enter/Space. Antes: inacessivel keyboard.
                  return (
                    <div key={n.id} onClick={onClickItem}
                      role="button" tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClickItem(); } }}
                      aria-label={`${n.title} - ${n.is_read ? 'lida' : 'nao lida'}`}
                      className={cls}>{inner}</div>
                  );
                })
              )}
            </div>

            {notifs.length > 0 && (
              /* FIX-WORKER-1 pass 510 (footer link UX honesty):
                 PRE-FIX BUG: link "Ver todas em Minha Conta" -> /conta (dashboard)
                 - User expecta lista de TODAS notifs (read + unread + pagination)
                 - Lands em /conta dashboard generic com cards (orders, products, etc)
                 - "Ver todas" = false promise -> confusao UX, perda confianca
                 - /conta/notificacoes existe MAS e prefs page (LGPD opt-in/out)
                 - Sem dedicated /conta/notificacoes/inbox listing
                 POST-FIX (honesty UX):
                 - Link aponta /conta/notificacoes (prefs page - notification-related)
                 - Text "Gerenciar preferencias" - reflete real destino
                 - Sem false promise "ver todas" (que nao existe ainda)
                 - User sabe que vai gerenciar opt-in/out, nao listar notifs
                 - Futuro: criar /conta/notificacoes/inbox dedicated listing
                   page se necessidade aparecer (atualmente bell suficiente p/ ~30 recents) */
              <footer className="p-3 border-t border-white/10 text-center">
                <Link href="/conta/notificacoes" onClick={() => setOpen(false)} className="text-xs text-magenta hover:underline focus-visible:outline-2 focus-visible:outline-magenta rounded">
                  Gerenciar preferencias
                </Link>
              </footer>
            )}
          </div>
        </>
      )}
    </div>
  );
}
