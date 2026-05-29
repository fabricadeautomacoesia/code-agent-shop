'use client';

export const dynamic = 'force-dynamic';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Lock, CheckCircle } from 'lucide-react';
import { Api } from '@/lib/api';
import { friendlyAuthError } from '@/lib/auth-errors';

export default function ResetPage() {
  return <Suspense fallback={<div className="container mx-auto px-6 py-16">Carregando...</div>}><ResetInner /></Suspense>;
}

function ResetInner() {
  const router = useRouter();
  const sp = useSearchParams();
  const token = sp.get('token') || '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pwScore, setPwScore] = useState(0);
  const [done, setDone] = useState(false);
  const [sessionsRevoked, setSessionsRevoked] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  function onPass(v: string) {
    setPassword(v);
    let s = 0;
    if (v.length >= 8) s++;
    if (/[A-Z]/.test(v)) s++;
    if (/[0-9]/.test(v)) s++;
    if (/[!@#$%^&*]/.test(v)) s++;
    setPwScore(s);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    if (password !== confirm) { setErr('Senhas nao coincidem'); return; }
    if (password.length < 8) { setErr('Senha muito curta (min 8)'); return; }
    // FIX-WORKER-1 pass 233 (client/backend rule parity): backend auth.js:775
    // exige maiuscula + numero + caractere especial. Client validava apenas 2 de 3
    // -> user submetia senha "Senha123" sem special char -> backend 400 com
    // mensagem generica via friendlyAuthError. UX: criar regra fail-fast client
    // alinhada com backend Zod schema (incluir especial).
    if (!/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[^\w\s]/.test(password)) {
      setErr('Senha precisa de maiuscula, numero e caractere especial (!@#$%^&* etc)');
      return;
    }
    setLoading(true);
    try {
      /* FIX-WORKER-1 pass 308: consume sessions_revoked from response (backend pass 282).
         PRE-FIX: redirect imediato 2.5s sem informar quantas sessoes foram invalidadas.
         User com 3 devices conectados nao sabia que TODOS foram desconectados.
         POST-FIX: cast response + state sessionsRevoked + render explicito no done view. */
      const r = await Api.api<{ sessions_revoked?: number }>(
        '/auth/reset-password',
        { method: 'POST', body: JSON.stringify({ token, password }) }
      );
      setSessionsRevoked(Number(r?.sessions_revoked || 0));
      setDone(true);
      // Delay maior se houver sessoes invalidadas (user precisa ler msg)
      const redirectDelay = (r?.sessions_revoked || 0) > 0 ? 4500 : 2500;
      setTimeout(() => router.push('/login?reset=1'), redirectDelay);
    } catch (e: any) {
      setErr(friendlyAuthError(e));
    } finally { setLoading(false); }
  }

  if (!token) return (
    <div className="container mx-auto px-6 py-16 max-w-md text-center">
      <h1 className="font-display font-bold text-2xl mb-3 text-red-400">Link invalido</h1>
      <Link href="/esqueci-senha" className="btn-primary">Solicitar novo link</Link>
    </div>
  );

  if (done) return (
    <div className="container mx-auto px-6 py-16 max-w-md">
      <div className="glass p-8 text-center">
        <CheckCircle className="w-16 h-16 mx-auto mb-4 text-green-400" aria-hidden="true" />
        <h1 className="font-display font-bold text-2xl mb-3">Senha redefinida!</h1>
        {/* FIX-WORKER-1 pass 308: feedback sessions_revoked count + pluralizacao PT-BR */}
        {sessionsRevoked > 0 && (
          <p className="text-sm text-yellow-300 bg-yellow-500/10 border border-yellow-500/30 p-3 rounded-lg mb-3">
            Por seguranca, {sessionsRevoked === 1
              ? '1 sessao ativa em outro dispositivo foi encerrada'
              : `${sessionsRevoked} sessoes ativas em outros dispositivos foram encerradas`}.
            Faca login novamente.
          </p>
        )}
        <p className="text-white/70">Redirecionando para login...</p>
      </div>
    </div>
  );

  const pwColors = ['#ef4444','#f59e0b','#eab308','#22c55e'];
  const pwWidths = ['25%','50%','75%','100%'];
  // FIX-WORKER-1 pass 3: text label para SR + visual reforco
  const pwLabels = ['Fraca','Razoavel','Boa','Forte'];

  // FIX-WORKER-1 pass 3: clear err quando user comeca a corrigir (era persistente)
  function clearErr() { if (err) setErr(''); }

  return (
    <div className="container mx-auto px-6 py-16 max-w-md">
      <h1 className="font-display font-bold text-4xl mb-2">Nova senha</h1>
      <p className="text-white/60 mb-8">Defina uma nova senha forte</p>

      <form onSubmit={submit} className="glass p-8 space-y-5">
        <div>
          <label htmlFor="pw-new" className="text-sm text-white/70 mb-1.5 block">Nova senha</label>
          <div className="relative">
            <Lock className="w-4 h-4 absolute left-3 top-3.5 text-white/40" aria-hidden="true" />
            <input id="pw-new" type="password" required value={password}
              onChange={(e) => { onPass(e.target.value); clearErr(); }}
              aria-describedby="pw-strength"
              autoComplete="new-password"
              className="w-full px-10 py-2.5 rounded-lg bg-white/5 border border-white/10 focus:border-magenta focus:outline-none" />
          </div>
          {/* FIX-WORKER-1 pass 3: progressbar role + text label SR-friendly */}
          <div id="pw-strength" className="mt-2 flex items-center gap-2">
            <div className="flex-1 h-1.5 bg-white/5 rounded-full overflow-hidden"
              role="progressbar"
              aria-valuemin={0} aria-valuemax={4} aria-valuenow={pwScore}
              aria-label={password.length > 0 ? `Forca da senha: ${pwLabels[pwScore-1] || 'Muito fraca'}` : 'Forca da senha (digite a senha)'}>
              <div className="h-full transition-all" style={{
                width: password.length > 0 ? (pwWidths[pwScore-1] || '10%') : '0',
                background: password.length > 0 ? (pwColors[pwScore-1] || '#ef4444') : 'transparent',
              }} />
            </div>
            {password.length > 0 && (
              <span className="text-xs text-white/60 min-w-[60px] text-right" style={{ color: pwColors[pwScore-1] || '#ef4444' }}>
                {pwLabels[pwScore-1] || 'Muito fraca'}
              </span>
            )}
          </div>
        </div>
        <div>
          <label htmlFor="pw-confirm" className="text-sm text-white/70 mb-1.5 block">Confirmar senha</label>
          <input id="pw-confirm" type="password" required value={confirm}
            onChange={(e) => { setConfirm(e.target.value); clearErr(); }}
            aria-describedby="pw-confirm-hint"
            autoComplete="new-password"
            className="w-full px-3 py-2.5 rounded-lg bg-white/5 border border-white/10 focus:border-magenta focus:outline-none" />
          {confirm.length > 0 && password !== confirm && (
            <div id="pw-confirm-hint" className="text-xs text-yellow-400 mt-1">Senhas ainda nao coincidem</div>
          )}
        </div>

        {err && (
          <div role="alert" className="text-sm text-red-400 bg-red-500/10 p-3 rounded-lg flex items-center justify-between">
            <span>{err}</span>
            {/* FIX-WORKER-1 pass 492 (a11y paridade register pass 183 + QnaForm pass 489) */}
            <button type="button" onClick={() => setErr('')}
              aria-label="Fechar mensagem de erro"
              className="text-xs hover:underline focus-visible:outline-2 focus-visible:outline-red-400 rounded">fechar</button>
          </div>
        )}

        <button type="submit" disabled={loading} className="btn-primary w-full disabled:opacity-50">
          {loading ? 'Salvando...' : 'Redefinir senha'}
        </button>
      </form>
    </div>
  );
}
