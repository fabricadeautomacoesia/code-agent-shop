'use client';

import { useEffect, useState } from 'react';
import { sellerFetch, fmtDate } from '@/lib/seller-api';
import { KeyRound, Plus, Trash2, AlertTriangle, CheckCircle2, RefreshCw, Calendar } from 'lucide-react';

/**
 * FIX-WORKER-5 pass 218: /byok dashboard seller (consume W17 pass 217 endpoints)
 *
 * 3 features:
 * 1. List minhas keys (provider/alias/fingerprint/quota/usage/rotation_due)
 * 2. Provision nova key (form com warning sobre rotation 90d)
 * 3. Revoke key (confirmDialog + reason input)
 *
 * SECURITY UX:
 * - plain_key field type=password (oculto durante digitacao)
 * - Warning "Chave nao sera mostrada novamente apos provision"
 * - Audit log seller-led visible em response (best-effort)
 */

const PROVIDERS = ['openai', 'anthropic', 'gemini', 'groq', 'cohere', 'mistral', 'azure-openai', 'custom'] as const;
type Provider = typeof PROVIDERS[number];

type VaultKey = {
  id: string;
  provider: string;
  key_alias: string;
  key_fingerprint: string;
  is_active: boolean;
  monthly_quota_usd_cents: number | null;
  usage_this_month_cents: number;
  expires_at: string | null;
  rotation_due_at: string | null;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
};

function fmtUSD(cents: number | null | undefined): string {
  const n = Number(cents) || 0;
  return `$${(n / 100).toFixed(2)}`;
}

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

export default function BYOKPage() {
  const [keys, setKeys] = useState<VaultKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [showProvision, setShowProvision] = useState(false);

  // Provision form state
  const [provider, setProvider] = useState<Provider>('openai');
  const [keyAlias, setKeyAlias] = useState('');
  const [plainKey, setPlainKey] = useState('');
  const [monthlyQuotaUSD, setMonthlyQuotaUSD] = useState('');
  const [rotationDays, setRotationDays] = useState('90');
  const [provisioning, setProvisioning] = useState(false);
  const [actionMsg, setActionMsg] = useState('');
  const [actionErr, setActionErr] = useState('');

  async function load() {
    setLoading(true);
    try {
      const r = await sellerFetch<{ keys: VaultKey[]; count: number }>('/vault/keys/me');
      setKeys(r.keys || []);
      setLoadError('');
    } catch (e: any) {
      setLoadError(e?.message || 'Erro ao carregar chaves');
    } finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  async function provision(e: React.FormEvent) {
    e.preventDefault();
    setActionMsg(''); setActionErr('');
    if (!keyAlias.trim() || !plainKey.trim()) {
      setActionErr('Preencha alias e chave.');
      return;
    }
    setProvisioning(true);
    try {
      const body: any = {
        provider,
        key_alias: keyAlias.trim(),
        plain_key: plainKey.trim(),
        rotation_days: parseInt(rotationDays, 10) || 90,
      };
      const quotaUSD = parseFloat(monthlyQuotaUSD);
      if (!Number.isNaN(quotaUSD) && quotaUSD > 0) {
        body.monthly_quota_usd_cents = Math.round(quotaUSD * 100);
      }
      const r = await sellerFetch<VaultKey>('/vault/keys/me', {
        method: 'POST', body: JSON.stringify(body),
      });
      setActionMsg(`Chave ${r.key_alias} criada. Fingerprint: ${r.key_fingerprint}`);
      // Reset form
      setKeyAlias(''); setPlainKey(''); setMonthlyQuotaUSD('');
      setShowProvision(false);
      load();
    } catch (e: any) {
      if (e?.status === 429 || e?.data?.statusCode === 429) {
        setActionErr('Limite de provisionamento atingido. Aguarde alguns minutos.');
      } else {
        setActionErr(e?.data?.message || e?.message || 'Erro ao criar chave');
      }
    } finally { setProvisioning(false); }
  }

  async function revoke(id: string, alias: string) {
    const { promptDialog } = await import('@/components/prompt-dialog');
    const reason = await promptDialog(`Motivo da revogacao de "${alias}":`, 'Ex: chave comprometida, rotacao manual');
    if (!reason) return;
    setActionMsg(''); setActionErr('');
    try {
      await sellerFetch(`/vault/keys/me/${id}/revoke`, {
        method: 'POST', body: JSON.stringify({ reason }),
      });
      setActionMsg(`Chave ${alias} revogada.`);
      load();
    } catch (e: any) {
      setActionErr(e?.data?.message || e?.message || 'Erro ao revogar');
    }
  }

  const activeKeys = keys.filter((k) => k.is_active);
  const revokedKeys = keys.filter((k) => !k.is_active);

  return (
    <div>
      <h1 className="font-display font-bold text-4xl mb-2">BYOK - API Keys</h1>
      <p className="text-white/60 mb-6">
        Gerencie suas chaves de API (OpenAI, Anthropic, Gemini, etc) para produtos AI agents.
      </p>

      {/* Action buttons */}
      <div className="flex gap-3 mb-6">
        <button type="button" onClick={() => setShowProvision(!showProvision)}
          aria-label={showProvision ? 'Cancelar provisionamento' : 'Provisionar nova chave de API'}
          aria-expanded={showProvision}
          className="btn-primary flex items-center gap-2 focus-visible:outline-2 focus-visible:outline-magenta">
          <Plus className="w-4 h-4" aria-hidden="true" />
          {showProvision ? 'Cancelar' : 'Nova chave'}
        </button>
        <button type="button" onClick={load} disabled={loading}
          aria-label="Recarregar lista de chaves"
          className="text-xs px-3 py-1.5 rounded-lg glass hover:border-magenta/40 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-magenta">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
        </button>
      </div>

      {/* PROVISION FORM */}
      {showProvision && (
        <form onSubmit={provision} className="glass p-6 mb-6 space-y-4">
          <h2 className="font-display font-bold text-xl">Provisionar nova chave</h2>
          <div className="bg-yellow-500/10 border border-yellow-500/30 text-yellow-300 p-3 rounded-lg text-sm flex gap-2">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" aria-hidden="true" />
            <div>
              <strong>Importante:</strong> a chave sera criptografada AES-256-GCM antes do storage.
              Apos provisionar, NUNCA sera mostrada novamente. Guarde uma copia segura no seu side.
              Rotacao 90d default - boas praticas PCI/SOC2.
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="byok-provider" className="text-sm text-white/70 mb-1.5 block">Provider</label>
              <select id="byok-provider" value={provider} onChange={(e) => setProvider(e.target.value as Provider)}
                className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm">
                {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="byok-alias" className="text-sm text-white/70 mb-1.5 block">Alias (apelido)</label>
              <input id="byok-alias" type="text" value={keyAlias} onChange={(e) => setKeyAlias(e.target.value)}
                required minLength={3} maxLength={100}
                autoComplete="off"
                placeholder="Ex: prod-openai-main"
                className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm" />
            </div>
          </div>

          <div>
            <label htmlFor="byok-key" className="text-sm text-white/70 mb-1.5 block">Chave (plain)</label>
            <input id="byok-key" type="password" value={plainKey} onChange={(e) => setPlainKey(e.target.value)}
              required minLength={10}
              autoComplete="off"
              placeholder="sk-... ou similar"
              className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm font-mono" />
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="byok-quota" className="text-sm text-white/70 mb-1.5 block">Quota mensal USD (opcional)</label>
              <input id="byok-quota" type="number" min="0" step="0.01" value={monthlyQuotaUSD}
                onChange={(e) => setMonthlyQuotaUSD(e.target.value)}
                placeholder="50.00"
                className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm" />
            </div>
            <div>
              <label htmlFor="byok-rotation" className="text-sm text-white/70 mb-1.5 block">Rotacao em dias (1-365)</label>
              <input id="byok-rotation" type="number" min="1" max="365" value={rotationDays}
                onChange={(e) => setRotationDays(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm" />
            </div>
          </div>

          <button type="submit" disabled={provisioning}
            className="btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-wait focus-visible:outline-2 focus-visible:outline-magenta">
            <KeyRound className="w-4 h-4" aria-hidden="true" />
            {provisioning ? 'Criptografando + provisionando...' : 'Provisionar chave'}
          </button>
        </form>
      )}

      {/* MSG BANNERS */}
      {actionMsg && (
        <div role="status" aria-live="polite" className="bg-green-500/10 border border-green-500/30 text-green-300 p-3 rounded-lg mb-4 text-sm flex items-start justify-between gap-2">
          <span className="flex items-center gap-2"><CheckCircle2 className="w-4 h-4" aria-hidden="true" />{actionMsg}</span>
          <button type="button" onClick={() => setActionMsg('')} aria-label="Fechar mensagem de sucesso" className="text-xs hover:underline focus-visible:outline-2 focus-visible:outline-green-400 rounded">fechar</button>
        </div>
      )}
      {actionErr && (
        <div role="alert" className="bg-red-500/10 border border-red-500/30 text-red-300 p-3 rounded-lg mb-4 text-sm flex items-start justify-between gap-2">
          <span className="flex items-center gap-2"><AlertTriangle className="w-4 h-4" aria-hidden="true" />{actionErr}</span>
          <button type="button" onClick={() => setActionErr('')} aria-label="Fechar mensagem de erro" className="text-xs hover:underline focus-visible:outline-2 focus-visible:outline-red-400 rounded">fechar</button>
        </div>
      )}

      {/* KEYS LIST */}
      <div className="glass p-6">
        <h2 className="font-display font-bold text-xl mb-4">Minhas chaves {activeKeys.length > 0 && `(${activeKeys.length} ativas)`}</h2>
        {loadError && (
          <div role="alert" className="bg-red-500/10 border border-red-500/30 text-red-400 p-3 rounded-lg mb-4 text-sm">{loadError}</div>
        )}
        {loading && keys.length === 0 ? (
          <p className="text-white/60 text-center py-8">Carregando...</p>
        ) : keys.length === 0 ? (
          <p className="text-white/60 text-center py-8">Voce ainda nao tem chaves. Click "Nova chave" para comecar.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-white/40 uppercase border-b border-white/10">
              <tr>
                <th className="py-2">Provider/Alias</th>
                <th>Fingerprint</th>
                <th>Usage</th>
                <th>Rotacao</th>
                <th>Status</th>
                <th className="text-right">Acoes</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => {
                const rotDays = daysUntil(k.rotation_due_at);
                const rotOverdue = rotDays !== null && rotDays < 0;
                const rotSoon = rotDays !== null && rotDays >= 0 && rotDays <= 7;
                return (
                  <tr key={k.id} className="border-b border-white/5 hover:bg-white/5">
                    <td className="py-3">
                      <div className="font-mono text-xs uppercase text-magenta">{k.provider}</div>
                      <div className="text-white/80">{k.key_alias}</div>
                    </td>
                    <td className="text-xs font-mono text-white/50">{k.key_fingerprint}</td>
                    <td className="text-xs">
                      {fmtUSD(k.usage_this_month_cents)}
                      {k.monthly_quota_usd_cents && <span className="text-white/40"> / {fmtUSD(k.monthly_quota_usd_cents)}</span>}
                    </td>
                    <td className="text-xs">
                      {k.rotation_due_at ? (
                        <span className={`inline-flex items-center gap-1 ${rotOverdue ? 'text-red-300' : rotSoon ? 'text-yellow-300' : 'text-white/60'}`}>
                          <Calendar className="w-3 h-3" aria-hidden="true" />
                          {rotOverdue ? `Vencida (${-rotDays!}d)` : `${rotDays}d`}
                        </span>
                      ) : <span className="text-white/30">-</span>}
                    </td>
                    <td>
                      <span className={`text-xs px-2 py-0.5 rounded ${k.is_active ? 'bg-green-500/20 text-green-300' : 'bg-white/10 text-white/40'}`}>
                        {k.is_active ? 'Ativa' : 'Revogada'}
                      </span>
                    </td>
                    <td className="text-right">
                      {k.is_active && (
                        <button type="button" onClick={() => revoke(k.id, k.key_alias)}
                          aria-label={`Revogar chave ${k.key_alias}`}
                          className="text-red-400 hover:underline text-xs inline-flex items-center gap-1 focus-visible:outline-2 focus-visible:outline-red-400 rounded">
                          <Trash2 className="w-3 h-3" aria-hidden="true" /> Revogar
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
