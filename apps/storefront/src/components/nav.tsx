'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Search, ShoppingCart, User, Menu, Code2, X, Zap, Bot, Workflow, Cpu, Users, Layers, Heart, Bell } from 'lucide-react';
import { useAuth, useUI } from '@/lib/store';
import { SearchAutocomplete } from './search-autocomplete';
import { NotificationBell } from './notification-bell';
import { WishlistBadge } from './wishlist-badge';
import { Dialog } from './dialog';

const NAV_LINKS = [
  { href: '/products?kind=ai_agent',    label: 'Agentes IA',      Icon: Bot,      color: 'hover:text-magenta' },
  { href: '/products?kind=n8n_workflow',label: 'Workflows n8n',   Icon: Workflow, color: 'hover:text-magenta' },
  { href: '/products?kind=automation',  label: 'Automacoes',      Icon: Cpu,      color: 'hover:text-magenta' },
  { href: '/promocoes',                  label: 'Promocoes',       Icon: Zap,      color: 'hover:text-orange-400 font-semibold' },
  { href: '/sellers',                    label: 'Vendedores',      Icon: Users,    color: 'hover:text-magenta' },
  { href: '/products',                   label: 'Tudo',            Icon: Layers,   color: 'hover:text-magenta' },
];

export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const { user } = useAuth();
  const { setCartOpen, searchOpen, setSearchOpen } = useUI();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', onScroll);
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // FIX-WORKER-3 pass 13: useEffect body lock + Escape REMOVIDOS - <Dialog>
  // wrapper (pass 9) agora gerencia ambos automaticamente via JSX declarativo.
  // Ver mobile drawer JSX abaixo - <Dialog open={mobileOpen} ...>.

  return (
    <>
    {searchOpen && <SearchAutocomplete onClose={() => setSearchOpen(false)} />}
    <nav className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
      scrolled ? 'glass-strong py-3' : 'py-5 bg-transparent'
    }`}>
      <div className="container mx-auto px-4 sm:px-6 flex items-center justify-between gap-2">
        <Link href="/" className="flex items-center gap-2 group flex-shrink-0">
          <div className="w-9 h-9 rounded-lg bg-gradient-vibe flex items-center justify-center shadow-lg shadow-magenta/30 group-hover:scale-110 transition-transform">
            <Code2 className="w-5 h-5 text-white" />
          </div>
          <span className="font-display font-bold text-base sm:text-xl tracking-tight whitespace-nowrap">
            Code<span className="text-magenta">&</span>Agent <span className="hidden sm:inline text-white/70">Shop</span>
          </span>
        </Link>

        {/* Desktop nav */}
        <div className="hidden lg:flex items-center gap-8 text-sm font-medium">
          {NAV_LINKS.map((l) => (
            <Link key={l.href} href={l.href} className={`transition-colors ${l.color}`}>{l.label}</Link>
          ))}
        </div>

        <div className="flex items-center gap-1 sm:gap-3">
          {/* FIX-WORKER-1 pass 156 (a11y): type='button' explicito p/ todos botoes
              de UI no nav. Default <button> em HTML5 e type='submit' - pode causar
              bug se nav for renderizado dentro de form (defensive).
              + aria-hidden em icones decorativos. */}
          <button type="button" onClick={() => setSearchOpen(true)} aria-label="Buscar" className="p-2 rounded-lg hover:bg-white/5 transition-colors focus-visible:outline-2 focus-visible:outline-magenta">
            <Search className="w-5 h-5" aria-hidden="true" />
          </button>
          <button type="button" onClick={() => setCartOpen(true)} aria-label="Carrinho" className="p-2 rounded-lg hover:bg-white/5 transition-colors relative focus-visible:outline-2 focus-visible:outline-magenta">
            <ShoppingCart className="w-5 h-5" aria-hidden="true" />
          </button>
          {/* FIX-WORKER-15 pass 3: ocultar Wishlist + Bell em <sm (< 640px).
              Mobile drawer expoe links /conta/favoritos + /conta (notifs).
              Antes: 4 icons (search+cart+wishlist+bell) + hamburger competiam
              por espaco em 375px, apertado e poluido. Padrao Mercado Livre mobile. */}
          <div className="hidden sm:flex items-center gap-1 sm:gap-3">
            <WishlistBadge />
            <NotificationBell />
          </div>
          {user ? (
            /* FIX-WORKER-8 pass 236 (Tailwind class conflict): remover "flex"
               inicial. "flex hidden sm:flex" gera 3 display rules competindo
               (flex -> none -> flex). Tailwind JIT resolve por ordem mas alguns
               build parsers/SSR podem gerar FOUC mobile (flash botao visivel
               antes do hidden aplicar). Pattern correto: declarar so estado
               default (hidden) + breakpoint override (sm:flex). items-center +
               gap-2 mantidos - aplicam quando display:flex ativa. */
            <Link href="/conta" className="btn-ghost text-sm items-center gap-2 hidden sm:flex">
              <User className="w-4 h-4" /> {user.display_name || user.full_name?.split(' ')[0]}
            </Link>
          ) : (
            <Link href="/login" className="btn-primary text-xs sm:text-sm hidden sm:inline-flex">Entrar</Link>
          )}
          {/* WORKER 15: hamburger mobile (icon Menu era importado mas nunca usado)
              FIX-WORKER-1 pass 156: type=button + aria-hidden icon */}
          <button type="button" onClick={() => setMobileOpen(true)} aria-label="Menu" className="lg:hidden p-2 rounded-lg hover:bg-white/5 transition-colors focus-visible:outline-2 focus-visible:outline-magenta">
            <Menu className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>
      </div>
    </nav>

    {/* Mobile drawer - FIX-WORKER-3 pass 13: refatorado p/ <Dialog> wrapper.
        lg:hidden no wrapper Dialog garante visibilidade so mobile.
        hideCloseButton=true porque header custom tem botao X manual. */}
    <Dialog
      open={mobileOpen}
      onClose={() => setMobileOpen(false)}
      ariaLabel="Menu de navegacao"
      variant="drawer-right"
      zIndex={70}
      closeLabel="Fechar menu"
      hideCloseButton
      className="relative top-0 right-0 h-full w-80 max-w-[85vw] glass-strong shadow-2xl lg:hidden transform transition-transform"
    >
          <div className="flex items-center justify-between p-4 border-b border-white/10">
            <span className="font-display font-bold">Menu</span>
            <button type="button" onClick={() => setMobileOpen(false)} aria-label="Fechar menu" className="p-1.5 rounded hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-magenta">
              <X className="w-5 h-5" aria-hidden="true" />
            </button>
          </div>
          <nav className="p-2 overflow-y-auto h-[calc(100%-60px)]">
            {NAV_LINKS.map((l) => (
              <Link key={l.href} href={l.href}
                onClick={() => setMobileOpen(false)}
                className={`flex items-center gap-3 px-4 py-3.5 rounded-lg text-sm transition-colors ${l.color}`}>
                <l.Icon className="w-4 h-4 opacity-70" />
                {l.label}
              </Link>
            ))}
            <div className="my-3 border-t border-white/10" />
            {user ? (
              <>
                <Link href="/conta" onClick={() => setMobileOpen(false)}
                  className="flex items-center gap-3 px-4 py-3.5 rounded-lg text-sm hover:bg-white/5 transition-colors">
                  <User className="w-4 h-4 opacity-70" />
                  Minha conta ({user.display_name || user.full_name?.split(' ')[0]})
                </Link>
                {/* FIX-WORKER-15 pass 3: shortcuts mobile para Favoritos + Notificacoes
                    (icons ocultos no nav header em < sm)
                    FIX-WORKER-15 pass 511 (Notificacoes link UX honesty - paridade pass 510):
                      PRE-FIX BUG: Notificacoes link -> /conta (mesma URL que "Minha conta")
                      - 2 links no drawer apontavam pro mesmo destino:
                        * "Minha conta" -> /conta (dashboard generic)
                        * "Notificacoes" -> /conta (mesmo lugar!) - false promise
                      - User clica Bell icon esperando ver notifs OR prefs
                      - Lands no dashboard generic com cards (orders, products, KYC)
                      - Confusao UX duplo: link redundante + destino errado
                      - Pass 510 corrigiu NotificationBell footer mesma issue
                      - Mobile drawer ficou LAGGED em paridade
                      POST-FIX: /conta/notificacoes (notification-related page)
                      - Aponta para preferences page (LGPD opt-in/out per channel)
                      - Match paridade pass 510 bell footer + /conta cards pass 228
                      - Mobile user com SR ja sabe: Bell -> prefs notifs */}
                <Link href="/conta/favoritos" onClick={() => setMobileOpen(false)}
                  className="flex items-center gap-3 px-4 py-3.5 rounded-lg text-sm hover:bg-white/5 transition-colors">
                  <Heart className="w-4 h-4 opacity-70" />
                  Favoritos
                </Link>
                <Link href="/conta/notificacoes" onClick={() => setMobileOpen(false)}
                  className="flex items-center gap-3 px-4 py-3.5 rounded-lg text-sm hover:bg-white/5 transition-colors">
                  <Bell className="w-4 h-4 opacity-70" />
                  Notificacoes
                </Link>
              </>
            ) : (
              <>
                <Link href="/login" onClick={() => setMobileOpen(false)}
                  className="flex items-center gap-3 px-4 py-3.5 rounded-lg text-sm hover:text-magenta transition-colors">
                  <User className="w-4 h-4 opacity-70" />
                  Entrar
                </Link>
                <Link href="/register" onClick={() => setMobileOpen(false)}
                  className="mx-2 my-1 btn-primary text-sm text-center block">
                  Criar conta
                </Link>
              </>
            )}
          </nav>
    </Dialog>
    </>
  );
}
