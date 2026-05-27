'use client';

/**
 * FIX-WORKER-4 pass 2: hook reutilizavel para admin actions com feedback
 *
 * Encapsula pattern repetido em todas pages admin:
 * - busy state (1 operacao por vez)
 * - error/success banners
 * - try/catch automatico
 * - auto-reload via reload() callback
 *
 * Uso:
 *   const action = useAdminAction(reload);
 *   <button onClick={() => action.run('approve-' + id, async () => {
 *     await adminFetch(`/sellers/admin/payouts/${id}/approve`, { method: 'POST' });
 *     return `Payout ${id.slice(0,8)} aprovado`;
 *   })}>Aprovar</button>
 *
 *   {action.error && <Banner type="error" msg={action.error} onClose={action.clear} />}
 *   {action.success && <Banner type="success" msg={action.success} onClose={action.clear} />}
 *
 * Returns:
 * - busyKey: identificador opaco da operacao em flight (null se idle)
 * - error/success: mensagens UI
 * - clear(): limpa ambos
 * - run(key, fn): executa fn com guards. Retorna msg do success.
 */

import { useState, useCallback } from 'react';

export interface UseAdminActionReturn {
  busyKey: string | null;
  error: string;
  success: string;
  clear: () => void;
  run: (key: string, fn: () => Promise<string | void>) => Promise<void>;
}

export function useAdminAction(reload?: () => Promise<void> | void): UseAdminActionReturn {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const clear = useCallback(() => { setError(''); setSuccess(''); }, []);

  const run = useCallback(async (key: string, fn: () => Promise<string | void>) => {
    if (busyKey) return; // dedup: ignora se ja tem operacao em flight
    setError(''); setSuccess(''); setBusyKey(key);
    try {
      const msg = await fn();
      if (typeof msg === 'string') setSuccess(msg);
      if (reload) await reload();
    } catch (e: any) {
      setError(`Falha: ${e?.message || 'erro desconhecido'}`);
    } finally {
      setBusyKey(null);
    }
  }, [busyKey, reload]);

  return { busyKey, error, success, clear, run };
}
