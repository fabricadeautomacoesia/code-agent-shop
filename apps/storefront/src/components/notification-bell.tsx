'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Bell, X, Check, CheckCheck } from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth } from '@/lib/store';

/**
 * Sininho de notificacoes in_app. Polling a cada 60s.
 * Click no item marca como lida.
 */
export function NotificationBell() {
  const { token } = useAuth();
  const [open, setOpen] = useState(false);
  const [notifs, setNotifs] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const unread = notifs.filter((n) => !n.is_read).length;

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
    if (!token) { setNotifs([]); return; }
    load();
    const i = setInterval(load, 60000);
    return () => clearInterval(i);
  }, [token]);

  async function markRead(id: string) {
    try {
      await Api.api(`/notifications/${id}/read`, { method: 'POST', auth: token! });
      setNotifs((p) => p.map((n) => n.id === id ? { ...n, is_read: true } : n));
    } catch {}
  }

  // FIX-WORKER-1: marcar todas como lidas em uma acao
  async function markAllRead() {
    try {
      await Api.api(`/notifications/read-all`, { method: 'POST', auth: token! });
      setNotifs((p) => p.map((n) => ({ ...n, is_read: true })));
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
                notifs.map((n) => (
                  <div key={n.id}
                    onClick={() => !n.is_read && markRead(n.id)}
                    className={`p-4 border-b border-white/5 cursor-pointer hover:bg-white/5 ${
                      !n.is_read ? 'bg-magenta/5 border-l-2 border-l-magenta' : ''
                    }`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold truncate">{n.title}</div>
                        <div className="text-xs text-white/60 mt-1 line-clamp-2">{n.body}</div>
                        <div className="text-[10px] text-white/40 mt-1">
                          {new Date(n.created_at).toLocaleString('pt-BR')}
                        </div>
                      </div>
                      {n.is_read ? <CheckCheck className="w-3 h-3 text-white/30 flex-shrink-0" />
                                 : <Check className="w-3 h-3 text-magenta flex-shrink-0" />}
                    </div>
                  </div>
                ))
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
