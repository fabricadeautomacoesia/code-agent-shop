'use client';

import { useEffect, useState } from 'react';
import { adminFetch, fmtDate } from '@/lib/admin-api';
import { useAdminAction } from '@/lib/use-admin-action';
import { AlertOctagon, Clock, ExternalLink, RefreshCw } from 'lucide-react';

/**
 * FIX-WORKER-4 pass 8: dashboard /admin/webhooks consome W11 pass 7 endpoint
 * GET /payments/webhooks/dead (jwt admin/staff).
 *
 * Lista webhooks Asaas "dead letter" (retry_count > 5 sem processar).
 * Cron reconciliation (5min interval) ja tenta auto-retry, esses sao falhas
 * persistentes que precisam investigacao humana.
 *
 * Refresh manual (sem auto-poll porque webhooks dead sao raros - listagem
 * humana, nao real-time monitoring).
 */
export default function AdminWebhooksPage() {
  const [webhooks, setWebhooks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  async function load() {
    setLoading(true);
    try {
      const r = await adminFetch<{ webhooks: any[]; count: number }>('/payments/webhooks/dead');
      setWebhooks(r.webhooks || []);
      setLoadError('');
      setLastUpdate(new Date());
    } catch (e: any) {
      setLoadError(e.message);
      setWebhooks([]);
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  // FIX-WORKER-11 pass 8: botao Reset chama POST /payments/webhooks/:id/reset
  // (em vez do antigo workflow psql UPDATE retry_count=0)
  const action = useAdminAction(load);

  async function resetWebhook(id: string) {
    if (!confirm(`Resetar webhook ${id.slice(0, 8)}... e tentar reprocessar imediatamente?`)) return;
    action.run(`reset-${id}`, async () => {
      const r = await adminFetch<{ ok: boolean; previous_retry_count: number }>(`/payments/webhooks/${id}/reset`, {
        method: 'POST',
      });
      return `Webhook resetado (retry_count era ${r.previous_retry_count}). Reprocessamento disparado.`;
    });
  }

  return (
    <div>
      <div className="flex items-end justify-between mb-8">
        <div>
          <h1 className="font-display font-bold text-4xl mb-2">Webhooks Asaas</h1>
          <p className="text-white/60">Dead letter queue (retry_count {'>'} 5 sem processar)</p>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdate && (
            <p className="text-xs text-white/40">
              Atualizado: {lastUpdate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </p>
          )}
          <button onClick={load} disabled={loading}
            className="text-xs px-3 py-1.5 rounded-lg glass hover:border-magenta/40 transition-colors disabled:opacity-50">
            {loading ? 'Atualizando...' : 'Atualizar'}
          </button>
        </div>
      </div>

      <div className="glass p-4 mb-6 border-l-4 border-yellow-500">
        <div className="flex items-start gap-3">
          <AlertOctagon className="w-5 h-5 text-yellow-400 flex-shrink-0 mt-0.5" aria-hidden="true" />
          <div className="text-sm">
            <strong className="text-yellow-300">O que sao webhooks dead letter?</strong>
            <p className="text-white/70 mt-1">
              Webhooks Asaas validos (HMAC OK) que falharam <strong>{'>'} 5 vezes</strong> ao processar.
              Cron de reconciliation tenta auto-retry a cada 5min, ate o limite. Apos isso, ficam
              aqui aguardando investigacao admin. Causas comuns: order_id orfao, schema desatualizado,
              bug processWebhookEvent.
            </p>
            <p className="text-white/70 mt-1">
              <strong>Para reprocessar:</strong> clique no botao <strong>Reset</strong> na linha do webhook.
              Acao reseta retry_count=0, limpa processing_error e dispara reprocessamento IMEDIATO
              (sem esperar o proximo cron 5min). Audit log registra acao com seu user.
            </p>
          </div>
        </div>
      </div>

      {loadError && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4 flex items-center justify-between">
          <span>Erro carregando dead letter: {loadError}</span>
          <button onClick={() => { setLoadError(''); load(); }} className="text-xs hover:underline">retry</button>
        </div>
      )}

      {/* FIX-WORKER-11 pass 8: banners reset action */}
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

      <div className="glass p-6">
        {loading && !webhooks.length ? (
          <p className="text-white/60 text-center py-12">Carregando...</p>
        ) : webhooks.length === 0 ? (
          <p className="text-white/60 text-center py-12 flex items-center justify-center gap-2">
            <AlertOctagon className="w-5 h-5 text-green-400" aria-hidden="true" />
            {loadError ? 'Nao foi possivel carregar a fila.' : 'Nenhum webhook dead letter. Sistema saudavel.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-white/40 uppercase border-b border-white/10">
                <tr>
                  <th className="py-2">Event</th>
                  <th>Payment ID</th>
                  <th>Retries</th>
                  <th>Recebido</th>
                  <th>Erro</th>
                  <th className="text-right">Acoes</th>
                </tr>
              </thead>
              <tbody>
                {webhooks.map((w) => (
                  <tr key={w.id} className="border-b border-white/5 hover:bg-white/5">
                    <td className="py-3">
                      <span className="px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-400 text-xs font-mono">
                        {w.event_type}
                      </span>
                    </td>
                    <td className="font-mono text-xs text-white/60">
                      {w.asaas_payment_id ? (
                        <a
                          href={`https://www.asaas.com/payments/${w.asaas_payment_id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:text-magenta inline-flex items-center gap-1"
                          title="Abrir no painel Asaas"
                        >
                          {w.asaas_payment_id.slice(0, 16)}...
                          <ExternalLink className="w-3 h-3" aria-hidden="true" />
                        </a>
                      ) : '-'}
                    </td>
                    <td>
                      <span className="px-2 py-0.5 rounded bg-red-500/20 text-red-400 text-xs font-bold">
                        {w.retry_count}x
                      </span>
                    </td>
                    <td className="text-xs text-white/50 whitespace-nowrap">
                      <Clock className="w-3 h-3 inline mr-1" aria-hidden="true" />
                      {fmtDate(w.received_at)}
                    </td>
                    <td className="max-w-md">
                      <div className="text-xs text-red-300 font-mono break-words line-clamp-2" title={w.processing_error}>
                        {w.processing_error || 'Sem detalhe (verifique logs do payment-svc)'}
                      </div>
                      <div className="text-[10px] text-white/40 font-mono mt-1">id: {w.id.slice(0, 8)}...</div>
                    </td>
                    {/* FIX-WORKER-11 pass 8: botao Reset (substitui workflow psql) */}
                    <td className="text-right">
                      <button onClick={() => resetWebhook(w.id)}
                        disabled={action.busyKey === `reset-${w.id}`}
                        aria-label={`Resetar e reprocessar webhook ${w.event_type}`}
                        className="text-magenta hover:underline text-xs inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-wait">
                        <RefreshCw className={`w-3 h-3 ${action.busyKey === `reset-${w.id}` ? 'animate-spin' : ''}`} aria-hidden="true" />
                        {action.busyKey === `reset-${w.id}` ? '...' : 'Reset'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
