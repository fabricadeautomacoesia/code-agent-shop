'use client';

import { useEffect, useState } from 'react';
import { adminFetch, fmtDate } from '@/lib/admin-api';
import { useAdminAction } from '@/lib/use-admin-action';
import { Plus, Trash2, KeyRound } from 'lucide-react';

// FIX-WORKER-4 pass 9: usage_this_month_cents e monthly_quota_usd_cents
// sao em USD CENTS (vault tracks LLM cost - OpenAI/Anthropic em USD), NAO em BRL.
// Antes: fmtBRL(k.usage_this_month_cents) renderizava "R$ 1.234,56" enganoso.
// Admin acreditava valor BRL, mas backend usa USD desde W17 schema (cost_usd_cents).
// Helper formata como "$ 12.34" (USD nativo).
function fmtUSD(cents: number | string | null | undefined): string {
  const v = Number(cents || 0) / 100;
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export default function VaultPage() {
  const [keys, setKeys] = useState<any[]>([]);
  const [form, setForm] = useState({ provider: 'openai', key_alias: '', plain_key: '', is_platform_pool: true, seller_id: '' });
  const [show, setShow] = useState(false);
  const [loadError, setLoadError] = useState('');

  async function load() {
    try { const r = await adminFetch<{ keys: any[] }>('/vault/keys'); setKeys(r.keys); setLoadError(''); }
    catch (e: any) { setLoadError(e.message); }
  }
  useEffect(() => { load(); }, []);

  // FIX-WORKER-4 pass 4: useAdminAction hook substitui try/catch ad-hoc
  const action = useAdminAction(load);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    action.run('create-key', async () => {
      await adminFetch('/vault/keys', { method: 'POST', body: JSON.stringify({
        ...form,
        seller_id: form.seller_id || null,
      })});
      setShow(false);
      setForm({ provider:'openai', key_alias:'', plain_key:'', is_platform_pool: true, seller_id:'' });
      return `Chave ${form.key_alias} provisionada (${form.provider})`;
    });
  }

  async function revoke(id: string) {
    const reason = prompt('Motivo da revogacao:');
    if (!reason) return;
    action.run(`revoke-${id}`, async () => {
      await adminFetch(`/vault/keys/${id}/revoke`, { method: 'POST', body: JSON.stringify({ reason }) });
      return `Chave ${id.slice(0, 8)}... revogada`;
    });
  }

  return (
    <div>
      <div className="flex justify-between items-end mb-8">
        <div>
          <h1 className="font-display font-bold text-4xl mb-2">Vault de API keys</h1>
          <p className="text-white/60">Cofre AES-256-GCM (V8 22.1) - chaves da plataforma e BYOK de sellers</p>
        </div>
        <button onClick={() => setShow(true)} className="btn-primary flex items-center gap-2"><Plus className="w-4 h-4" /> Provisionar chave</button>
      </div>

      {/* FIX-WORKER-4 pass 9: loadError com retry (pattern W4 pass 6, 7, 8) */}
      {loadError && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4 flex items-center justify-between">
          <span>Erro carregando lista: {loadError}</span>
          <button onClick={() => { setLoadError(''); load(); }} className="text-xs hover:underline">retry</button>
        </div>
      )}

      {/* FIX-WORKER-4 pass 4: banners via useAdminAction (DRY com payouts/qa-queue/sellers/products) */}
      {action.error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4 flex items-center justify-between">
          <span>{action.error}</span>
          <button onClick={action.clear} className="text-xs hover:underline">fechar</button>
        </div>
      )}
      {action.success && (
        <div className="bg-green-500/10 border border-green-500/30 text-green-400 p-4 rounded-lg mb-4 flex items-center justify-between">
          <span>{action.success}</span>
          <button onClick={action.clear} className="text-xs hover:underline">fechar</button>
        </div>
      )}

      {show && (
        <form onSubmit={create} className="glass p-6 mb-6 space-y-3">
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-white/60 uppercase">Provider</label>
              <select value={form.provider} onChange={(e) => setForm({...form, provider: e.target.value})}
                className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm">
                {['openai','anthropic','gemini','groq','cohere','mistral'].map((p) => <option key={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-white/60 uppercase">Alias</label>
              <input value={form.key_alias} onChange={(e) => setForm({...form, key_alias: e.target.value})} required
                placeholder="openai-prod-shared-001"
                className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm" />
            </div>
          </div>
          <div>
            <label className="text-xs text-white/60 uppercase">Chave (plain, sera criptografada)</label>
            <input value={form.plain_key} onChange={(e) => setForm({...form, plain_key: e.target.value})} required type="password"
              className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm font-mono" />
          </div>
          <div>
            <label className="text-xs text-white/60 uppercase">Seller especifico (deixe vazio para platform pool)</label>
            <input value={form.seller_id} onChange={(e) => setForm({...form, seller_id: e.target.value})}
              placeholder="UUID do seller (opcional)"
              className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm font-mono" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.is_platform_pool}
              onChange={(e) => setForm({...form, is_platform_pool: e.target.checked})} />
            Pool da plataforma (Classe B usa fallback)
          </label>
          <div className="flex gap-2">
            <button type="submit" disabled={action.busyKey === 'create-key'}
              className="btn-primary disabled:opacity-50 disabled:cursor-wait">
              {action.busyKey === 'create-key' ? 'Provisionando...' : 'Provisionar'}
            </button>
            <button type="button" onClick={() => setShow(false)} className="px-5 py-2.5 rounded-lg border border-white/10">Cancelar</button>
          </div>
        </form>
      )}

      <div className="glass p-6 overflow-x-auto">
        {keys.length === 0 ? (
          /* FIX-WORKER-4 pass 9: empty state explicit (era tabela vazia silenciosa) */
          <div className="text-center py-12 text-white/60">
            <KeyRound className="w-16 h-16 mx-auto mb-4 text-white/20" aria-hidden="true" />
            {loadError ? 'Nao foi possivel carregar as chaves.' : (
              <>
                <p className="text-lg mb-2">Nenhuma chave provisionada ainda.</p>
                <p className="text-sm">Clique em "Provisionar chave" para adicionar a primeira (OpenAI, Anthropic, etc).</p>
              </>
            )}
          </div>
        ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-white/40 uppercase border-b border-white/10">
            <tr>
              <th className="py-2">Alias</th>
              <th>Provider</th>
              <th>Pool</th>
              {/* FIX-WORKER-4 pass 9: Header USD explicit (era so "Uso/mes" ambiguo BRL/USD) */}
              <th>Uso mes (USD)</th>
              <th>Quota (USD)</th>
              <th>Status</th>
              <th>Criado</th>
              <th className="text-right">Acoes</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => {
              const busy = action.busyKey === `revoke-${k.id}`;
              // FIX-WORKER-4 pass 9: mascaramento fingerprint p/ DLP screenshot.
              // fp e sha256.slice(0,16) - 16 chars hex. Mostrar 4 inicio + 4 fim = 8 chars visiveis.
              const fpMasked = k.key_fingerprint
                ? `${k.key_fingerprint.slice(0, 4)}...${k.key_fingerprint.slice(-4)}`
                : '-';
              return (
                <tr key={k.id} className="border-b border-white/5 hover:bg-white/5">
                  <td className="py-3">
                    <div className="font-mono text-xs">{k.key_alias}</div>
                    <div className="text-[10px] text-white/40" title={`fingerprint completa: ${k.key_fingerprint}`}>
                      fp: {fpMasked}
                    </div>
                  </td>
                  <td>{k.provider}</td>
                  <td>{k.is_platform_pool ? <span className="text-magenta">platform</span> : <span className="text-white/60">seller</span>}</td>
                  {/* FIX-WORKER-4 pass 9 CRITICAL: fmtUSD em vez de fmtBRL (currency mismatch) */}
                  <td className="font-mono text-xs">{fmtUSD(k.usage_this_month_cents)}</td>
                  <td className="font-mono text-xs">{k.monthly_quota_usd_cents ? fmtUSD(k.monthly_quota_usd_cents) : '-'}</td>
                  <td>
                    {k.is_active
                      ? <span className="px-2 py-0.5 rounded bg-green-500/20 text-green-400 text-xs">active</span>
                      : <span className="px-2 py-0.5 rounded bg-red-500/20 text-red-400 text-xs">revoked</span>}
                  </td>
                  <td className="text-xs text-white/40">{fmtDate(k.created_at)}</td>
                  <td className="text-right">
                    {k.is_active && (
                      <button onClick={() => revoke(k.id)} disabled={busy}
                        aria-label={`Revogar chave ${k.key_alias}`}
                        className="text-red-400 hover:underline text-xs inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-wait">
                        <Trash2 className="w-3 h-3" aria-hidden="true" /> {busy ? '...' : 'Revogar'}
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
