'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminFetch, fmtDate } from '@/lib/admin-api';
import { useAdminAction } from '@/lib/use-admin-action';
import { Plus, Trash2, KeyRound, RefreshCw } from 'lucide-react';

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
  // FIX-WORKER-4 pass 11: rotation_days no form (W17 pass 12 backend aceita)
  const [form, setForm] = useState({ provider: 'openai', key_alias: '', plain_key: '', is_platform_pool: true, seller_id: '', rotation_days: 90 });
  const [show, setShow] = useState(false);
  const [loadError, setLoadError] = useState('');
  // FIX-WORKER-4 pass 11: rotacao counters (W17 pass 12 endpoint)
  const [rotationDue, setRotationDue] = useState<{ overdue: number; soon: number }>({ overdue: 0, soon: 0 });

  async function load() {
    try { const r = await adminFetch<{ keys: any[] }>('/vault/keys'); setKeys(r.keys); setLoadError(''); }
    catch (e: any) { setLoadError(e.message); }
    // Fetch paralelo: rotation-due counters (W17 pass 12)
    try {
      const r = await adminFetch<{ keys: any[] }>('/vault/keys/rotation-due');
      let overdue = 0, soon = 0;
      for (const k of (r.keys || [])) {
        const d = Math.floor(Number(k.days_remaining || 0));
        if (d < 0) overdue++;
        else if (d <= 7) soon++;
      }
      setRotationDue({ overdue, soon });
    } catch { /* silent - endpoint pode nao existir em deploy antigo */ }
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
      setForm({ provider:'openai', key_alias:'', plain_key:'', is_platform_pool: true, seller_id:'', rotation_days: 90 });
      return `Chave ${form.key_alias} provisionada (${form.provider}) - renova em ${form.rotation_days}d`;
    });
  }

  async function revoke(id: string) {
    // FIX-WORKER-17 pass 382 (a11y + UX consistency vault revoke):
    //   PRE-FIX: prompt() nativo (vs rotateKey usa promptDialog moderno)
    //   - Inconsistencia W4 admin pattern
    //   - Vault revoke = SECURITY CRITICAL (chave AES-256-GCM revogada)
    //   - Deveria ter confirmDialog danger variant + promptDialog reason
    //   POST-FIX: paridade pattern V8 W4 critical actions consolidacao
    const { confirmDialog, promptDialog } = await import('@/components/prompt-dialog');
    if (!await confirmDialog('Revogar esta chave AES-256?', {
      body: 'Apos revogada, a chave NAO podera mais ser usada para decrypt/encrypt. Operacoes dependentes da chave falharao ate nova chave ser provisionada.',
      variant: 'danger', confirmLabel: 'Sim, revogar',
    })) return;
    const reason = await promptDialog('Motivo da revogacao (audit log):', 'Ex: chave comprometida, rotacao manual, compliance');
    if (!reason) return;
    action.run(`revoke-${id}`, async () => {
      await adminFetch(`/vault/keys/${id}/revoke`, { method: 'POST', body: JSON.stringify({ reason }) });
      return `Chave ${id.slice(0, 8)}... revogada`;
    });
  }

  // FIX-WORKER-17 pass 13: rotate 1-click - cria nova + revoga atomic
  async function rotateKey(id: string, alias: string) {
    // FIX-WORKER-17 pass 382 (promptDialog p/ plain_key - era prompt() nativo):
    //   PRE-FIX: prompt(`Cole nova chave plain`) browser nativo
    //   - Chave AES-256-GCM plain NUNCA deveria passar por prompt() (nao mask)
    //   - prompt nativo expone em browser history (acessivel via dev tools)
    //   - Sync block UI durante input critico
    //   - Sem visual security signal (vs promptDialog inputType=password)
    //   POST-FIX: promptDialog inputType="password" (UX masked typing)
    //   + sequence reordenada: confirmDialog ANTES (intencao) -> plain_key -> reason
    const { confirmDialog, promptDialog } = await import('@/components/prompt-dialog');
    if (!await confirmDialog(`Confirma rotacao de "${alias}"?`, {
      body: 'Nova chave sera ATIVADA e antiga REVOGADA na mesma transacao. Tenha a nova chave plain pronta.',
      variant: 'danger', confirmLabel: 'Prosseguir',
    })) return;
    const plain_key = await promptDialog(
      `Cole a NOVA chave plain para "${alias}":`,
      'sk-...',
      '',
      { inputType: 'password' }
    );
    if (!plain_key || plain_key.length < 10) return;
    const reason = await promptDialog('Motivo da rotacao (audit log):', 'Ex: rotacao 90d programada', 'rotacao programada') || 'rotacao programada';
    action.run(`rotate-${id}`, async () => {
      const r = await adminFetch<{ new_fingerprint: string; new_key_id: string }>(
        `/vault/keys/${id}/rotate`,
        { method: 'POST', body: JSON.stringify({ plain_key, reason, rotation_days: 90 }) }
      );
      return `Chave "${alias}" rotacionada. Nova fp: ${r.new_fingerprint}`;
    });
  }

  return (
    <div>
      <div className="flex justify-between items-end mb-8">
        <div>
          <h1 className="font-display font-bold text-4xl mb-2">Vault de API keys</h1>
          <p className="text-white/60">Cofre AES-256-GCM (V8 22.1) - chaves da plataforma e BYOK de sellers</p>
        </div>
        {/* FIX-WORKER-4 pass 172 (a11y V8 R23): type=button + aria-label */}
        <button type="button" onClick={() => setShow(true)}
          aria-label="Abrir formulario para provisionar nova chave de API"
          className="btn-primary flex items-center gap-2 focus-visible:outline-2 focus-visible:outline-magenta">
          <Plus className="w-4 h-4" aria-hidden="true" /> Provisionar chave
        </button>
      </div>

      {/* FIX-WORKER-4 pass 9 + 172 (a11y V8 R23): role=alert + type=button + aria-label */}
      {loadError && (
        <div role="alert" className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4 flex items-center justify-between">
          <span>Erro carregando lista: {loadError}</span>
          <button type="button" onClick={() => { setLoadError(''); load(); }}
            aria-label="Tentar carregar lista novamente"
            className="text-xs hover:underline focus-visible:outline-2 focus-visible:outline-red-400 rounded">retry</button>
        </div>
      )}

      {/* FIX-WORKER-4 pass 11: rotation alert banner consume W17 pass 12 endpoint */}
      {(rotationDue.overdue > 0 || rotationDue.soon > 0) && (
        <div className={`p-4 rounded-lg mb-4 border-l-4 ${
          rotationDue.overdue > 0
            ? 'bg-red-500/10 border-red-500 text-red-200'
            : 'bg-yellow-500/10 border-yellow-500 text-yellow-200'
        }`}>
          <div className="font-semibold text-sm mb-1">
            {rotationDue.overdue > 0
              ? `${rotationDue.overdue} chave(s) com rotacao VENCIDA - acao urgente`
              : `${rotationDue.soon} chave(s) com rotacao em ate 7 dias`}
          </div>
          <div className="text-xs opacity-80">
            Risco: token revogado pelo upstream causa 100% errors em prod.
            Localize abaixo pelos badges "Vencida Xd" ou "Renova Xd" e provisione nova chave com mesmo alias.
          </div>
        </div>
      )}

      {/* FIX-WORKER-4 pass 4 + 172 (a11y V8 R23): role=alert/status + type=button + aria-label */}
      {action.error && (
        <div role="alert" className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4 flex items-center justify-between">
          <span>{action.error}</span>
          <button type="button" onClick={action.clear} aria-label="Fechar mensagem de erro"
            className="text-xs hover:underline focus-visible:outline-2 focus-visible:outline-red-400 rounded">fechar</button>
        </div>
      )}
      {action.success && (
        <div role="status" aria-live="polite" className="bg-green-500/10 border border-green-500/30 text-green-400 p-4 rounded-lg mb-4 flex items-center justify-between">
          <span>{action.success}</span>
          <button type="button" onClick={action.clear} aria-label="Fechar mensagem de sucesso"
            className="text-xs hover:underline focus-visible:outline-2 focus-visible:outline-green-400 rounded">fechar</button>
        </div>
      )}

      {show && (
        {/* FIX-WORKER-4 pass 154 (a11y): vault create form 6 inputs htmlFor + id
            + aria-describedby (rotation hint) + autoComplete=off (PII chave) */}
        <form onSubmit={create} className="glass p-6 mb-6 space-y-3">
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <label htmlFor="vault-provider" className="text-xs text-white/60 uppercase">Provider</label>
              <select id="vault-provider" value={form.provider} onChange={(e) => setForm({...form, provider: e.target.value})}
                className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm">
                {['openai','anthropic','gemini','groq','cohere','mistral'].map((p) => <option key={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="vault-alias" className="text-xs text-white/60 uppercase">Alias</label>
              <input id="vault-alias" value={form.key_alias} onChange={(e) => setForm({...form, key_alias: e.target.value})} required
                autoComplete="off"
                placeholder="openai-prod-shared-001"
                className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm" />
            </div>
          </div>
          <div>
            <label htmlFor="vault-plainkey" className="text-xs text-white/60 uppercase">Chave (plain, sera criptografada)</label>
            <input id="vault-plainkey" value={form.plain_key} onChange={(e) => setForm({...form, plain_key: e.target.value})} required type="password"
              autoComplete="new-password"
              aria-describedby="vault-plainkey-hint"
              className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm font-mono" />
            <p id="vault-plainkey-hint" className="text-[10px] text-white/40 mt-1">
              AES-256-GCM encryption antes de gravar no DB. Plain key nunca persistida.
            </p>
          </div>
          <div>
            <label htmlFor="vault-seller" className="text-xs text-white/60 uppercase">Seller especifico (deixe vazio para platform pool)</label>
            <input id="vault-seller" value={form.seller_id} onChange={(e) => setForm({...form, seller_id: e.target.value})}
              autoComplete="off"
              placeholder="UUID do seller (opcional)"
              className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm font-mono" />
          </div>
          {/* FIX-WORKER-4 pass 11: input rotation_days (W17 pass 12 backend) */}
          <div>
            <label htmlFor="vault-rotation" className="text-xs text-white/60 uppercase">Periodo de rotacao (dias)</label>
            <input id="vault-rotation" type="number" inputMode="numeric" min={1} max={365} value={form.rotation_days}
              onChange={(e) => setForm({...form, rotation_days: Number(e.target.value) || 90})}
              aria-describedby="vault-rotation-hint"
              className="w-32 px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm" />
            <span id="vault-rotation-hint" className="ml-2 text-xs text-white/50">
              Default 90d (PCI/SOC2). Use 30d para chaves criticas, 365d para internal-only.
            </span>
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
              {/* FIX-WORKER-4 pass 10: Saude 7d (error rate via idx_vault_usage_failures) */}
              <th>Saude 7d</th>
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
                  {/* FIX-WORKER-4 pass 543 (vault audit forensic link consolidacao -
                      paridade pass 451 orders + 452 sellers + 455 payouts):
                      PRE-FIX: vault keys table key_alias plain text - SEM
                      investigation flow apesar de vault ser SECURITY CRITICAL.
                      Real risk vault: AES-256-GCM keys = compromise = data leak.
                      Admin via "rotate" / "revoke" buttons mas SEM:
                      a. Trail forense por key (quem rotacionou, quando, motivo)
                      b. One-click drill-down ao audit_log
                      c. Cross-svc cross-reference (vault.* actions queryable)
                      POST-FIX: + Link "audit" target_id=k.id target_type=vault_api_key.
                      Consume pass 430 backend (audit_log target filtering).
                      Forensic flow consolidado todos 4 admin critical pages:
                      orders + sellers + payouts + vault (este). */}
                  <td className="py-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="font-mono text-xs">{k.key_alias}</div>
                      <Link
                        href={`/audit-log?target_id=${k.id}&target_type=vault_api_key`}
                        aria-label={`Audit log da chave ${k.key_alias}`}
                        title="Ver audit log da chave (forensic)"
                        className="text-[10px] text-white/30 hover:text-magenta-glow underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-magenta rounded">
                        audit
                      </Link>
                    </div>
                    <div className="text-[10px] text-white/40" title={`fingerprint completa: ${k.key_fingerprint}`}>
                      fp: {fpMasked}
                    </div>
                  </td>
                  <td>{k.provider}</td>
                  <td>{k.is_platform_pool ? <span className="text-magenta">platform</span> : <span className="text-white/60">seller</span>}</td>
                  {/* FIX-WORKER-4 pass 9 CRITICAL: fmtUSD em vez de fmtBRL (currency mismatch) */}
                  <td className="font-mono text-xs">{fmtUSD(k.usage_this_month_cents)}</td>
                  <td className="font-mono text-xs">{k.monthly_quota_usd_cents ? fmtUSD(k.monthly_quota_usd_cents) : '-'}</td>
                  {/* FIX-WORKER-4 pass 10: Saude 7d coluna baseada em error_rate (W14-7 indice + W17 enriched endpoint) */}
                  <td>
                    {(() => {
                      const calls = Number(k.calls_7d || 0);
                      const errors = Number(k.errors_7d || 0);
                      const rate = Number(k.error_rate || 0);
                      if (calls === 0) {
                        return <span className="px-2 py-0.5 rounded bg-white/10 text-white/40 text-xs" title="Sem uso nos ultimos 7 dias">Idle</span>;
                      }
                      const pct = (rate * 100).toFixed(1);
                      const tooltipText = `${errors}/${calls} chamadas falharam (${pct}%) nos ultimos 7 dias`;
                      if (rate === 0) {
                        return <span className="px-2 py-0.5 rounded bg-green-500/20 text-green-400 text-xs" title={tooltipText}>OK</span>;
                      }
                      if (rate < 0.05) {
                        return <span className="px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-400 text-xs" title={tooltipText}>Watch {pct}%</span>;
                      }
                      return <span className="px-2 py-0.5 rounded bg-red-500/20 text-red-400 text-xs" title={tooltipText}>Issues {pct}%</span>;
                    })()}
                  </td>
                  <td>
                    {/* FIX-WORKER-4 pass 11: status com badge rotation_due_at (W17 pass 12).
                        Layout: status principal + linha secundaria "Renova em Xd" se aplicavel.
                        Cores: vermelho overdue / amarelo <=7d / cinza >7d ou null. */}
                    <div className="flex flex-col gap-1">
                      {k.is_active
                        ? <span className="px-2 py-0.5 rounded bg-green-500/20 text-green-400 text-xs">active</span>
                        : <span className="px-2 py-0.5 rounded bg-red-500/20 text-red-400 text-xs">revoked</span>}
                      {k.is_active && k.rotation_due_at && (() => {
                        const daysLeft = Math.floor((new Date(k.rotation_due_at).getTime() - Date.now()) / 86400000);
                        const isOverdue = daysLeft < 0;
                        const isSoon = daysLeft >= 0 && daysLeft <= 7;
                        const tip = `Rotacao due ${new Date(k.rotation_due_at).toLocaleDateString('pt-BR')}`;
                        if (isOverdue) {
                          return <span title={tip} className="px-1.5 py-0.5 rounded bg-red-500/20 text-red-300 text-[10px] uppercase font-bold">Vencida {Math.abs(daysLeft)}d</span>;
                        }
                        if (isSoon) {
                          return <span title={tip} className="px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-300 text-[10px] uppercase font-semibold">Renova {daysLeft}d</span>;
                        }
                        return <span title={tip} className="text-[10px] text-white/40">{daysLeft}d p/ renovar</span>;
                      })()}
                    </div>
                  </td>
                  <td className="text-xs text-white/40">{fmtDate(k.created_at)}</td>
                  <td className="text-right space-x-2">
                    {k.is_active && (
                      <>
                        {/* FIX-WORKER-17 pass 13 + 172: type=button (V8 R23) */}
                        <button type="button" onClick={() => rotateKey(k.id, k.key_alias)}
                          disabled={busy || action.busyKey === `rotate-${k.id}`}
                          aria-label={`Rotacionar chave ${k.key_alias}`}
                          className="text-magenta hover:underline text-xs inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-wait focus-visible:outline-2 focus-visible:outline-magenta rounded">
                          <RefreshCw className={`w-3 h-3 ${action.busyKey === `rotate-${k.id}` ? 'animate-spin' : ''}`} aria-hidden="true" />
                          {action.busyKey === `rotate-${k.id}` ? '...' : 'Rotacionar'}
                        </button>
                        <button type="button" onClick={() => revoke(k.id)}
                          disabled={busy || action.busyKey === `rotate-${k.id}`}
                          aria-label={`Revogar chave ${k.key_alias}`}
                          className="text-red-400 hover:underline text-xs inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-wait focus-visible:outline-2 focus-visible:outline-red-400 rounded">
                          <Trash2 className="w-3 h-3" aria-hidden="true" /> {busy ? '...' : 'Revogar'}
                        </button>
                      </>
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
