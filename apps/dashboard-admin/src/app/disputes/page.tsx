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
import Link from 'next/link';
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
    // FIX-WORKER-4 pass 383 (UX consistency + enum validation - paridade 381+382):
    //   PRE-FIX: prompt() nativo aceita texto livre p/ resolution_action.
    //   - User digita typo (refund_approved -> refund_aproved sem D) -> backend
    //     400 Zod enum reject -> errorHandler UI generico
    //   - prompt nativo browser-blocking (inconsistente W4 admin UX)
    //   - last legacy prompt() em dashboard-admin (W4 consistency 100% completion)
    //   POST-FIX: promptDialog + client-side enum validation
    //   - Valores permitidos no body do prompt (UX hint)
    //   - Validation antes do submit (early UX feedback)
    //   - Paridade pattern V8 W4 (passes 381 forceApprove, 382 vault revoke)
    const { promptDialog, alertDialog } = await import('@/components/prompt-dialog');
    let resolution_action: string | null;
    if (action_type === 'buyer') {
      resolution_action = await promptDialog(
        'Tipo de resolucao em favor do buyer:',
        'refund_approved | replacement_sent | partial_refund',
        'refund_approved'
      );
      // Client-side enum validation (paridade backend Zod)
      const VALID = ['refund_approved', 'replacement_sent', 'partial_refund'];
      if (resolution_action && !VALID.includes(resolution_action.trim())) {
        await alertDialog('Tipo invalido', `Use exatamente: ${VALID.join(' | ')}`);
        return;
      }
      resolution_action = resolution_action ? resolution_action.trim() : null;
    } else if (action_type === 'seller') {
      resolution_action = 'dismissed';
    } else {
      resolution_action = 'dismissed';
    }
    if (!resolution_action) return;

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
      {/* FIX-WORKER-4 pass 565 (a11y - paridade pass 541/561 icons consolidacao):
          AlertTriangle heading icon decorativo + texto 'Disputas' descritivo. */}
      <h1 className="font-display font-bold text-4xl mb-2 flex items-center gap-3">
        <AlertTriangle className="w-8 h-8 text-yellow-400" aria-hidden="true" /> Disputas
      </h1>
      <p className="text-white/60 mb-6">Triagem e resolucao de disputas abertas por compradores.</p>

      {/* Filtros status - FIX-WORKER-4 pass 165 (a11y): radiogroup pattern + type=button */}
      <h2 id="disputes-filter-label" className="sr-only">Filtrar disputas por status</h2>
      <div role="radiogroup" aria-labelledby="disputes-filter-label" className="flex flex-wrap gap-2 mb-6">
        {(['opened','under_review','resolved_buyer','resolved_seller','cancelled',''] as Status[]).map((s) => (
          <button key={s || 'all'} type="button" onClick={() => setFilter(s)}
            role="radio" aria-checked={filter === s}
            className={`px-3 py-1.5 rounded-lg text-sm border transition-colors focus-visible:outline-2 focus-visible:outline-magenta ${
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
        <div role="alert" className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4 flex items-center justify-between">
          <span>Erro carregando: {loadError}</span>
          <button type="button" onClick={() => { setLoadError(''); load(); }}
            aria-label="Tentar carregar disputas novamente"
            className="text-xs hover:underline focus-visible:outline-2 focus-visible:outline-magenta rounded">retry</button>
        </div>
      )}

      {action.error && (
        <div role="alert" className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4 flex items-center justify-between">
          <span>{action.error}</span>
          <button type="button" onClick={action.clear}
            aria-label="Fechar mensagem de erro"
            className="text-xs hover:underline focus-visible:outline-2 focus-visible:outline-magenta rounded">fechar</button>
        </div>
      )}
      {action.success && (
        <div role="status" aria-live="polite" className="bg-green-500/10 border border-green-500/30 text-green-400 p-4 rounded-lg mb-4 flex items-center justify-between">
          <span>{action.success}</span>
          <button type="button" onClick={action.clear}
            aria-label="Fechar mensagem de sucesso"
            className="text-xs hover:underline focus-visible:outline-2 focus-visible:outline-magenta rounded">fechar</button>
        </div>
      )}

      {data.disputes.length === 0 ? (
        /* FIX-WORKER-4 pass 565 (a11y empty state - paridade pass 544/556):
            role=status SR announce + Clock icon aria-hidden. */
        <div role="status" className="glass p-12 text-center text-white/50">
          <Clock className="w-12 h-12 mx-auto mb-3 opacity-30" aria-hidden="true" />
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
                    {/* FIX-WORKER-4 pass 565 (dispute forensic audit link - completa
                        cadeia admin CRITICAL pages 451/452/455/543):
                        PRE-FIX: dispute row sem investigation flow.
                        - Disputes = REAL MONEY arbitration (refund/replacement decisions)
                        - Admin via status/reason mas SEM:
                          a. Trail forense de transitions opened->under_review->resolved
                          b. One-click drill-down ao audit_log
                          c. Cross-svc cross-reference (dispute.* + order.* actions)
                        POST-FIX: + Link 'audit' target_type=dispute
                        Pattern V8 W4 admin CRITICAL forensic flow COMPLETO 5/5 pages:
                        pass 451 orders + 452 sellers + 455 payouts + 543 vault +
                        565 (este) disputes. */}
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className={`px-2 py-0.5 rounded text-[10px] uppercase font-bold border ${STATUS_COLORS[d.status]}`}>
                        {STATUS_LABELS[d.status]}
                      </span>
                      <span className="text-xs text-white/40">#{d.order_number}</span>
                      <span className="text-xs text-magenta-glow font-mono">{fmtBRL(d.total_cents)}</span>
                      <Link
                        href={`/audit-log?target_id=${d.id}&target_type=dispute`}
                        aria-label={`Ver audit log da disputa #${d.order_number}`}
                        title="Ver audit log da disputa (forensic)"
                        className="text-[10px] text-white/30 hover:text-magenta-glow underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-magenta rounded">
                        audit
                      </Link>
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
                    /* FIX-WORKER-4 pass 165 (a11y): type=button + aria-label dinamico c/ dispute # */
                    <div className="flex flex-col gap-1.5 flex-shrink-0" role="group" aria-label={`Acoes disputa #${d.order_number}`}>
                      <button type="button" onClick={() => resolveDispute(d.id, 'buyer')}
                        disabled={action.busyKey === `resolve-${d.id}`}
                        aria-label={`Resolver disputa #${d.order_number} a favor do comprador`}
                        className="text-green-400 hover:underline text-xs inline-flex items-center gap-1 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-magenta rounded">
                        <CheckCircle className="w-3 h-3" aria-hidden="true" /> Favor buyer
                      </button>
                      <button type="button" onClick={() => resolveDispute(d.id, 'seller')}
                        disabled={action.busyKey === `resolve-${d.id}`}
                        aria-label={`Resolver disputa #${d.order_number} a favor do vendedor`}
                        className="text-purple-400 hover:underline text-xs inline-flex items-center gap-1 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-magenta rounded">
                        <XCircle className="w-3 h-3" aria-hidden="true" /> Favor seller
                      </button>
                      <button type="button" onClick={() => resolveDispute(d.id, 'cancel')}
                        disabled={action.busyKey === `resolve-${d.id}`}
                        aria-label={`Cancelar disputa #${d.order_number}`}
                        className="text-white/40 hover:underline text-xs inline-flex items-center gap-1 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-magenta rounded">
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
