'use client';

/**
 * FIX-WORKER-5 pass 1: hook reutilizavel para seller dashboard actions.
 * Mesmo pattern que useAdminAction (dashboard-admin W4 passes 1-5).
 *
 * Uso:
 *   const action = useSellerAction(reload);
 *   action.run(`submit-${id}`, async () => {
 *     await sellerFetch(...);
 *     return 'mensagem de sucesso';
 *   });
 *
 *   {action.error && <Banner error={action.error} />}
 *   {action.success && <Banner success={action.success} />}
 */

import { useState, useCallback } from 'react';

export interface UseSellerActionReturn {
  busyKey: string | null;
  error: string;
  success: string;
  clear: () => void;
  run: (key: string, fn: () => Promise<string | void>) => Promise<void>;
}

export function useSellerAction(reload?: () => Promise<void> | void): UseSellerActionReturn {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const clear = useCallback(() => { setError(''); setSuccess(''); }, []);

  const run = useCallback(async (key: string, fn: () => Promise<string | void>) => {
    if (busyKey) return;
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
