'use client';

/**
 * FIX-WORKER-4: /admin/disputes - listar e resolver disputas abertas
 *
 * Consome endpoints W7 pass 31 (esta iter):
 *   GET  /orders/admin/disputes?status=opened|under_review|resolved_buyer|resolved_seller|cancelled
 *   POST /orders/admin/disputes/:id/resolve { resolution_action, admin_notes, next_status, refund_amount_cents? }
 *
 * Status enum schema (mig 007):
 *   opened           - dispute aberta (waiting admin triage)
 *   under_review     - admin assumiu (pode pedir seller_response)
 *   resolved_buyer   - decidida a favor buyer (refund/replacement)
 *   resolved_seller  - decidida a favor seller (dismissed)
 *   cancelled        - dispute encerrada sem decisao (buyer desistiu)
 */

import { useEffect, useState } from 'react';
import { adminFetch, fmtDate, fmtBRL } from '@/lib/admin-api';
import { useAdminAction } from '@/lib/use-admin-action';
import { AlertTriangle, CheckCircle, XCircle, Clock } from 'lucide-react';

type Status = '' | 'opened' | 'under_review' | 'resolved_buyer' | 'resolved_seller' | 'cancelled';

const STATUS_LABELS: Record<string, string> = {
  opened: 'Aberta',
  under_review: 'Em analise',
  resolved_buyer: 'Resolvida (buyer)',
  resolved_seller: 'Resolvida (seller)',
  cancelled: 'Cancelada',
};

const STATUS_COLORS: Record<string, string> = {
  opened: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
  under_review: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  resolved_buyer: 'bg-green-500/20 text-green-300 border-green-500/30',
  resolved_seller: 'bg-purple-500/20 text-purple-300 border-purple-500/30',
  cancelled: 'bg-white/10 text-white/50 border-white/15',
};

const REASON_LABELS: Record<string, string> = {
  not_as_described: 'Nao corresponde a descricao',
  not_working: 'Nao funciona',
  plagiarism: 'Plagio',
  support_missing: 'Suporte ausente',
};

export default function DisputesPage() {
  const [filter, setFilter] = useState<Status>('opened');
  const [data, setData] = useState<any>({ disputes: [], counts: {} });
  const [loadError, setLoadError] = useState('');
  const action = useAdminAction(load);

  async function load() {
    try {
      const qs = filter ? `?status=${filter}` : '';
      const r = await adminFetch<any>(`/orders/admin/disputes${qs}`);
      setData(r);
      setLoadError('');
    } catch (e: any) {
      setLoadError(e?.message || 'Erro carregando disputas');
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filter]);

  async function resolveDispute(id: string, action_type: 'buyer' | 'seller' | 'cancel') {
    const resolution_action = action_type === 'buyer'
      ? prompt('Tipo de resolucao buyer:\nrefund_approved | replacement_sent | partial_refund')
      : action_type === 'seller'
        ? 'dismissed'
        : 'dismissed';
    if (!resolution_action) return;

    // FIX-WORKER-4 pass 153: substitui prompt() + alert() nativos por PromptDialog
    const { promptDialog, alertDialog } = await import('@/components/prompt-dialog');
    const admin_notes = await promptDialog(
      'Notas administrativas (min 10 chars):',
      'Ex: vendedor entregou produto incorreto, comprador comprovou via anexos'
    );
    if (!admin_notes || admin_notes.length < 10) {
      await alertDialog('Notas obrigatorias', 'Minimo 10 caracteres para auditoria.');
      return;
    }

    const next_status =
      action_type === 'buyer' ? 'resolved_buyer' :
      action_type === 'seller' ? 'resolved_seller' :
      'cancelled';

    let refund_amount_cents: number | undefined;
    if (resolution_action === 'partial_refund') {
      const amount = await promptDialog(
        'Valor do reembolso parcial (em centavos):',
        'Ex: 5000 = R\$ 50,00'
      );
      const n = parseInt(amount || '0', 10);
      if (!Number.isFinite(n) || n <= 0) {
        await alertDialog('Valor invalido', 'Use apenas digitos. Ex: 5000 para R\$ 50,00');
        return;
      }
      refund_amount_cents = n;
    }

    action.run(`resolve-${id}`, async () => {
      await adminFetch(`/orders/admin/disputes/${id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ resolution_action, admin_notes, next_status, refund_amount_cents }),
      });
      return `Disputa ${id.slice(0, 8)}... resolvida (${next_status})`;
    });
  }

  return (
    <div>
      <h1 className="font-display font-bold text-4xl mb-2 flex items-center gap-3">
        <AlertTriangle className="w-8 h-8 text-yellow-400" /> Disputas
      </h1>
      <p className="text-white/60 mb-6">Triagem e resolucao de disputas abertas por compradores.</p>

      {/* Filtros status */}
      <div className="flex flex-wrap gap-2 mb-6">
        {(['opened','under_review','resolved_buyer','resolved_seller','cancelled',''] as Status[]).map((s) => (
          <button key={s || 'all'} onClick={() => setFilter(s)}
            className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
              filter === s ? 'bg-magenta text-white border-magenta' : 'border-white/10 hover:border-white/30'
            }`}>
            {s ? STATUS_LABELS[s] : 'Todas'}
            {s && data.counts?.[s] ? (
              <span className="ml-1.5 text-xs opacity-70">({data.counts[s]})</span>
            ) : null}
          </button>
        ))}
      </div>

      {loadError && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4 flex items-center justify-between">
          <span>Erro carregando: {loadError}</span>
          <button onClick={() => { setLoadError(''); load(); }} className="text-xs hover:underline">retry</button>
        </div>
      )}

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

      {data.disputes.length === 0 ? (
        <div className="glass p-12 text-center text-white/50">
          <Clock className="w-12 h-12 mx-auto mb-3 opacity-30" />
          Nenhuma disputa {filter ? STATUS_LABELS[filter].toLowerCase() : ''} no momento.
        </div>
      ) : (
        <div className="space-y-3">
          {data.disputes.map((d: any) => {
            const canResolve = ['opened','under_review'].includes(d.status);
            return (
              <div key={d.id} className="glass p-4 hover:bg-white/5 transition-colors">
                <div className="flex items-start justify-between gap-4 mb-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`px-2 py-0.5 rounded text-[10px] uppercase font-bold border ${STATUS_COLORS[d.status]}`}>
                        {STATUS_LABELS[d.status]}
                      </span>
                      <span className="text-xs text-white/40">#{d.order_number}</span>
                      <span className="text-xs text-magenta-glow font-mono">{fmtBRL(d.total_cents)}</span>
                    </div>
                    <div className="text-sm font-semibold mb-1">
                      {REASON_LABELS[d.reason_code] || d.reason_code} - solicita: {d.requested_resolution}
                    </div>
                    <div className="text-xs text-white/60 line-clamp-2 mb-2">{d.description}</div>
                    <div className="text-[11px] text-white/40 flex flex-wrap items-center gap-3">
                      <span>Buyer: {d.buyer_name || d.buyer_email}</span>
                      <span>Seller: {d.seller_store_name || '-'}</span>
                      <span>Aberta: {fmtDate(d.opened_at)}</span>
                      {d.resolved_at && <span>Resolvida: {fmtDate(d.resolved_at)}</span>}
                      {d.resolution_action && (
                        <span className="text-magenta">Acao: {d.resolution_action}</span>
                      )}
                    </div>
                  </div>
                  {canResolve && (
                    <div className="flex flex-col gap-1.5 flex-shrink-0">
                      <button onClick={() => resolveDispute(d.id, 'buyer')}
                        disabled={action.busyKey === `resolve-${d.id}`}
                        className="text-green-400 hover:underline text-xs inline-flex items-center gap-1 disabled:opacity-50">
                        <CheckCircle className="w-3 h-3" /> Favor buyer
                      </button>
                      <button onClick={() => resolveDispute(d.id, 'seller')}
                        disabled={action.busyKey === `resolve-${d.id}`}
                        className="text-purple-400 hover:underline text-xs inline-flex items-center gap-1 disabled:opacity-50">
                        <XCircle className="w-3 h-3" /> Favor seller
                      </button>
                      <button onClick={() => resolveDispute(d.id, 'cancel')}
                        disabled={action.busyKey === `resolve-${d.id}`}
                        className="text-white/40 hover:underline text-xs inline-flex items-center gap-1 disabled:opacity-50">
                        Cancelar
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
