'use client';

/**
 * FIX-WORKER-1 pass 228: /conta/notificacoes UI (consume W13 pass 227 endpoints)
 *
 * Features:
 * - Lista templates por categoria
 * - Toggle switch por (template, channel) com optimistic update
 * - Critical templates (security_*) bloqueados como "Sempre ativo" (regulatorio)
 * - Bulk patch via PATCH /api/notifications/prefs
 *
 * Patterns industry (Stripe/Mercado Livre):
 * - Default ENABLED (row apenas em opt-out)
 * - Critical bypass (security_refresh_reuse, password_reset, 2fa_disabled, asaas_refund_failed)
 */

export const dynamic = 'force-dynamic';

import { useEffect, useState } from 'react';
import { Bell, Mail, Send, Shield, AlertCircle, CheckCircle, Lock } from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth } from '@/lib/store';

const CATEGORIES: Record<string, { label: string; icon: any; templates: { code: string; label: string }[] }> = {
  orders: {
    label: 'Pedidos',
    icon: CheckCircle,
    templates: [
      { code: 'order_paid', label: 'Pedido confirmado (pago)' },
      { code: 'order_refunded', label: 'Pedido reembolsado' },
    ],
  },
  reviews_qna: {
    label: 'Reviews & Q&A',
    icon: Bell,
    templates: [
      { code: 'review_replied', label: 'Vendedor respondeu sua avaliacao' },
      { code: 'qna_answered', label: 'Sua pergunta foi respondida' },
      { code: 'report_resolved', label: 'Sua denuncia foi processada' },
    ],
  },
  loyalty: {
    label: 'Programa de Pontos',
    icon: Bell,
    templates: [{ code: 'loyalty_tier_up', label: 'Voce subiu de tier' }],
  },
  product_updates: {
    label: 'Atualizacoes de produtos',
    icon: Bell,
    templates: [{ code: 'product_new_version', label: 'Nova versao de produto que voce favoritou/comprou' }],
  },
  marketing: {
    label: 'Marketing & Promocoes',
    icon: Mail,
    templates: [{ code: 'welcome', label: 'Boas-vindas / engagement' }],
  },
};

const CRITICAL_BLOCKED: Record<string, string> = {
  password_reset: 'Reset de senha',
  '2fa_disabled': 'Alertas 2FA',
  security_refresh_reuse: 'Alertas de seguranca de sessao',
  asaas_refund_failed: 'Refund failures (admin-only)',
};

const CHANNELS = [
  { code: 'in_app', label: 'In-app', icon: Bell },
  { code: 'email', label: 'Email', icon: Mail },
  { code: 'telegram', label: 'Telegram', icon: Send },
];

type Pref = { template_code: string; channel: string; is_enabled: boolean };

export default function NotificacoesPage() {
  const { token } = useAuth();
  const [prefs, setPrefs] = useState<Pref[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState('');

  async function load() {
    if (!token) return;
    setLoading(true);
    try {
      const r = await Api.api<{ prefs: Pref[]; count: number }>('/notifications/prefs', { auth: token });
      setPrefs(r.prefs || []);
      setLoadError('');
    } catch (e: any) {
      setLoadError(e?.message || 'Erro ao carregar preferencias');
    } finally { setLoading(false); }
  }

  useEffect(() => { load(); }, [token]);

  function isEnabled(code: string, channel: string): boolean {
    const p = prefs.find((x) => x.template_code === code && x.channel === channel);
    return p ? p.is_enabled : true; // default ENABLED
  }

  async function toggle(code: string, channel: string, newValue: boolean) {
    if (!token || saving) return;
    setSaving(true); setSavedMsg('');

    // Optimistic update
    setPrefs((prev) => {
      const existing = prev.find((x) => x.template_code === code && x.channel === channel);
      if (existing) {
        return prev.map((x) => x === existing ? { ...x, is_enabled: newValue } : x);
      }
      return [...prev, { template_code: code, channel, is_enabled: newValue }];
    });

    try {
      await Api.api('/notifications/prefs', {
        method: 'PATCH', auth: token,
        body: JSON.stringify({ prefs: [{ template_code: code, channel, is_enabled: newValue }] }),
      });
      setSavedMsg('Preferencias atualizadas');
      setTimeout(() => setSavedMsg(''), 3000);
    } catch (e: any) {
      // Revert optimistic
      load();
      setLoadError(e?.message || 'Erro ao salvar preferencia');
    } finally { setSaving(false); }
  }

  if (!token) {
    return (
      <div className="container mx-auto px-6 py-16 max-w-lg text-center">
        <h1 className="font-display font-bold text-3xl mb-4">Faca login</h1>
        <p className="text-white/60">Acesse sua conta para configurar preferencias.</p>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-6 py-8 max-w-3xl">
      <h1 className="font-display font-bold text-4xl mb-2 flex items-center gap-3">
        <Bell className="w-8 h-8 text-magenta" aria-hidden="true" />
        Preferencias de Notificacao
      </h1>
      <p className="text-white/60 mb-8">
        Escolha quais notificacoes voce recebe por email, in-app e Telegram. Voce pode desativar marketing
        e atualizacoes mas alertas de seguranca sao sempre enviados (regulatorio LGPD/PCI).
      </p>

      {savedMsg && (
        <div role="status" aria-live="polite"
          className="mb-6 p-3 rounded-lg bg-green-500/10 border border-green-500/30 text-green-300 text-sm flex items-center gap-2">
          <CheckCircle className="w-4 h-4" aria-hidden="true" /> {savedMsg}
        </div>
      )}
      {loadError && (
        <div role="alert" className="mb-6 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
          {loadError}
        </div>
      )}

      {/* CATEGORIES */}
      {loading ? (
        <div className="glass p-8 text-center text-white/60">Carregando preferencias...</div>
      ) : (
        <div className="space-y-6">
          {Object.entries(CATEGORIES).map(([catKey, cat]) => {
            const Icon = cat.icon;
            return (
              <div key={catKey} className="glass p-6">
                <h2 className="font-display font-bold text-xl mb-4 flex items-center gap-2">
                  <Icon className="w-5 h-5 text-magenta" aria-hidden="true" />
                  {cat.label}
                </h2>
                <div className="space-y-3">
                  {cat.templates.map((tpl) => (
                    <div key={tpl.code} className="grid grid-cols-1 md:grid-cols-2 gap-3 items-center p-3 rounded-lg bg-white/5">
                      <div className="text-sm font-medium">{tpl.label}</div>
                      <div className="flex gap-3">
                        {CHANNELS.map((ch) => {
                          const ChIcon = ch.icon;
                          const enabled = isEnabled(tpl.code, ch.code);
                          return (
                            <button key={ch.code} type="button"
                              onClick={() => toggle(tpl.code, ch.code, !enabled)}
                              disabled={saving}
                              aria-pressed={enabled}
                              aria-label={`${enabled ? 'Desativar' : 'Ativar'} ${tpl.label} via ${ch.label}`}
                              className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors focus-visible:outline-2 focus-visible:outline-magenta ${
                                enabled
                                  ? 'bg-magenta/20 text-magenta-glow border border-magenta/40'
                                  : 'bg-white/5 text-white/40 border border-white/10 hover:bg-white/10'
                              } disabled:opacity-50`}>
                              <ChIcon className="w-3 h-3" aria-hidden="true" />
                              {ch.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}

          {/* CRITICAL TEMPLATES (read-only, always-on) */}
          <div className="glass p-6 border border-yellow-500/20">
            <h2 className="font-display font-bold text-xl mb-3 flex items-center gap-2">
              <Lock className="w-5 h-5 text-yellow-400" aria-hidden="true" />
              Alertas de Seguranca (sempre ativos)
            </h2>
            <p className="text-xs text-white/60 mb-4">
              Estas notificacoes sao obrigatorias por regulatorio (LGPD, PCI-DSS). Voce nao pode desativar.
            </p>
            <div className="space-y-2">
              {Object.entries(CRITICAL_BLOCKED).map(([code, label]) => (
                <div key={code} className="flex items-center justify-between p-2 rounded bg-yellow-500/5 border border-yellow-500/10">
                  <span className="text-sm text-white/80 flex items-center gap-2">
                    <Shield className="w-4 h-4 text-yellow-400" aria-hidden="true" />
                    {label}
                  </span>
                  <span className="text-xs text-yellow-400 uppercase font-bold tracking-wider">Sempre ativo</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
