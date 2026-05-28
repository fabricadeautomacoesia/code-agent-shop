'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Package, ShoppingBag, Settings, Shield, LogOut, Store, Star, Heart, User, Bell } from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth } from '@/lib/store';

export default function ContaPage() {
  const router = useRouter();
  const { token, user, clear } = useAuth();
  const [me, setMe] = useState<any>(null);
  const [orders, setOrders] = useState<any[]>([]);
  const [loyalty, setLoyalty] = useState<any>(null);

  useEffect(() => {
    if (!token) { router.push('/login'); return; }
    Api.me(token).then((r) => setMe(r.user)).catch(() => clear());
    Api.api('/orders', { auth: token }).then((r: any) => setOrders(r.orders || [])).catch(() => {});
    Api.api<any>('/loyalty/me', { auth: token, cache: 'no-store' })
      .then((r: any) => setLoyalty(r?.loyalty || null))
      .catch(() => {});
  }, [token]);

  function logout() {
    Api.api('/auth/logout', { method: 'POST', auth: token! }).catch(() => {});
    clear();
    router.push('/');
  }

  if (!me) return <div className="container mx-auto px-6 py-16 text-center text-white/60">Carregando...</div>;

  return (
    <div className="container mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="font-display font-bold text-4xl">Ola, {me.display_name || me.full_name?.split(' ')[0]}</h1>
          <p className="text-white/60">{me.email} <span className="px-2 py-0.5 rounded-md bg-magenta/20 text-xs ml-2">{me.role}</span></p>
        </div>
        {/* FIX-WORKER-1 pass 163 (a11y): type=button + aria-label + LogOut aria-hidden + focus-visible */}
        <button type="button" onClick={logout}
          aria-label="Sair da conta (logout)"
          className="btn-ghost flex items-center gap-2 text-sm focus-visible:outline-2 focus-visible:outline-magenta">
          <LogOut className="w-4 h-4" aria-hidden="true" /> Sair
        </button>
      </div>

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4 mb-12">
        {[
          { href: '/conta/pedidos',  Icon: ShoppingBag, label: 'Meus pedidos',   desc: `${orders.length} pedido(s)` },
          { href: '/conta/pedidos',  Icon: Package,     label: 'Downloads',      desc: 'Baixar produtos comprados' },
          { href: '/conta/pontos',   Icon: Star,        label: 'CAS Pontos',
            desc: loyalty
              ? `${Number(loyalty.points_balance).toLocaleString('pt-BR')} pts - tier ${loyalty.tier}`
              : 'Ver saldo e historico' },
          { href: '/conta/favoritos',Icon: Heart,       label: 'Favoritos',      desc: 'Produtos salvos' },
          // FIX-WORKER-1 pass 3: card editar perfil (CPF/nome/telefone)
          { href: '/conta/perfil',   Icon: User,        label: 'Editar perfil',
            desc: me.cpf_cnpj ? 'Nome, CPF, telefone' : 'Complete CPF para pagar' },
          { href: '/conta/seguranca',Icon: Shield,      label: 'Seguranca + 2FA',desc: me.twofa_enabled ? '2FA ativo' : 'Ativar 2FA' },
          // FIX-WORKER-1 pass 228: Preferencias de notificacao (W13 pass 227 LGPD)
          { href: '/conta/notificacoes', Icon: Bell, label: 'Notificacoes', desc: 'Email/in-app/Telegram opt-in/out' },
          ...(me.role === 'seller'
            ? [{ href: '/seller/dashboard', Icon: Store, label: 'Painel vendedor', desc: 'Gerenciar loja' }]
            : [{ href: '/register?role=seller', Icon: Store, label: 'Tornar-se vendedor', desc: 'Comece a vender' }]
          ),
        ].map((c) => (
          <Link key={c.href} href={c.href} className="glass p-5 hover:scale-105 transition-transform">
            <c.Icon className="w-7 h-7 text-magenta mb-3" />
            <div className="font-display font-semibold">{c.label}</div>
            <div className="text-xs text-white/50 mt-1">{c.desc}</div>
          </Link>
        ))}
      </div>

      <div className="glass p-6">
        <h2 className="font-display font-bold text-xl mb-4">Pedidos recentes</h2>
        {orders.length === 0 ? (
          <p className="text-white/60">Voce ainda nao fez nenhum pedido. <Link href="/products" className="text-magenta hover:underline">Explorar catalogo</Link></p>
        ) : (
          <div className="space-y-2">
            {orders.slice(0, 10).map((o) => (
              <Link key={o.id} href={`/conta/pedidos/${o.id}`} className="flex items-center justify-between p-3 rounded-lg hover:bg-white/5">
                <div>
                  <div className="font-mono text-sm">{o.order_number}</div>
                  <div className="text-xs text-white/50">{new Date(o.created_at).toLocaleDateString('pt-BR')}</div>
                </div>
                <div className="text-right">
                  <div className="font-display font-bold">{Api.formatBRL(o.total_cents)}</div>
                  <div className={`text-xs ${o.status === 'paid' || o.status === 'fulfilled' ? 'text-green-400' : 'text-yellow-400'}`}>{o.status}</div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
