'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Search, ShoppingCart, User, Menu, Code2 } from 'lucide-react';
import { useAuth, useUI } from '@/lib/store';

export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const { user } = useAuth();
  const { setCartOpen, setSearchOpen } = useUI();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', onScroll);
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <nav className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
      scrolled ? 'glass-strong py-3' : 'py-5 bg-transparent'
    }`}>
      <div className="container mx-auto px-6 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2 group">
          <div className="w-9 h-9 rounded-lg bg-gradient-vibe flex items-center justify-center shadow-lg shadow-magenta/30 group-hover:scale-110 transition-transform">
            <Code2 className="w-5 h-5 text-white" />
          </div>
          <span className="font-display font-bold text-xl tracking-tight">
            Code<span className="text-magenta">&</span>Agent <span className="text-white/70">Shop</span>
          </span>
        </Link>

        <div className="hidden lg:flex items-center gap-8 text-sm font-medium">
          <Link href="/products?kind=ai_agent" className="hover:text-magenta transition-colors">Agentes IA</Link>
          <Link href="/products?kind=n8n_workflow" className="hover:text-magenta transition-colors">Workflows n8n</Link>
          <Link href="/products?kind=automation" className="hover:text-magenta transition-colors">Automacoes</Link>
          <Link href="/products" className="hover:text-magenta transition-colors">Tudo</Link>
        </div>

        <div className="flex items-center gap-3">
          <button onClick={() => setSearchOpen(true)} className="p-2 rounded-lg hover:bg-white/5 transition-colors">
            <Search className="w-5 h-5" />
          </button>
          <button onClick={() => setCartOpen(true)} className="p-2 rounded-lg hover:bg-white/5 transition-colors relative">
            <ShoppingCart className="w-5 h-5" />
          </button>
          {user ? (
            <Link href="/conta" className="btn-ghost text-sm flex items-center gap-2">
              <User className="w-4 h-4" /> {user.display_name || user.full_name?.split(' ')[0]}
            </Link>
          ) : (
            <Link href="/login" className="btn-primary text-sm">Entrar</Link>
          )}
        </div>
      </div>
    </nav>
  );
}
