'use client';

export const dynamic = 'force-dynamic';

import { useState } from 'react';
import Link from 'next/link';
import { Mail, CheckCircle } from 'lucide-react';
import { Api } from '@/lib/api';
import { friendlyAuthError } from '@/lib/auth-errors';

export default function EsqueciSenhaPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  // FIX-WORKER-1 pass 4: clearErr auto on input (era persistente ate submit)
  function clearErr() { if (err) setErr(''); }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setErr('');
    try {
      // FIX-WORKER-1 pass 183: normaliza email client-side (espelha backend pass 182)
      await Api.api('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email: email.trim().toLowerCase() }) });
      setSent(true);
    } catch (e: any) {
      setErr(friendlyAuthError(e));
    } finally { setLoading(false); }
  }

  if (sent) return (
    <div className="container mx-auto px-6 py-16 max-w-md">
      {/* FIX-WORKER-1 pass 549 (a11y success state announcement):
          PRE-FIX: success card sem role=status/aria-live. SR (NVDA/JAWS)
          nao anunciava o estado pos-submit. User com deficiencia visual
          nao sabia se request completou - precisava 'tabular' p/ achar
          o novo conteudo. UX critico em authflows.
          POST-FIX: role='status' aria-live='polite' no container.
          Paridade pass 519 /sellers + pass 544 qna seller empty state. */}
      <div role="status" aria-live="polite" className="glass p-8 text-center">
        <CheckCircle className="w-16 h-16 mx-auto mb-4 text-green-400" aria-hidden="true" />
        <h1 className="font-display font-bold text-2xl mb-3">Email enviado</h1>
        <p className="text-white/70 mb-6">
          Se o email <strong>{email}</strong> estiver cadastrado, voce recebera instrucoes para
          redefinir sua senha. O link expira em 15 minutos.
        </p>
        {/* FIX-WORKER-1 pass 4: dica anti-suporte (user nao recebeu? checar spam) */}
        <p className="text-xs text-white/40 mb-6">
          Nao recebeu? Verifique a pasta de spam ou aguarde 2-3min. Se persistir, contate suporte.
        </p>
        {/* FIX pass 549: focus-visible outline magenta na CTA voltar (era ausente) */}
        <Link href="/login"
          className="btn-primary inline-block focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-magenta">
          Voltar ao login
        </Link>
      </div>
    </div>
  );

  return (
    <div className="container mx-auto px-6 py-16 max-w-md">
      <h1 className="font-display font-bold text-4xl mb-2">Esqueci minha senha</h1>
      <p className="text-white/60 mb-8">Receba um link para redefinir sua senha</p>

      <form onSubmit={submit} className="glass p-8 space-y-5">
        <div>
          {/* FIX-WORKER-1 pass 4: htmlFor + id (WCAG 1.3.1 / 3.3.2 label-for) */}
          <label htmlFor="forgot-email" className="text-sm text-white/70 mb-1.5 block">Email cadastrado</label>
          <div className="relative">
            <Mail className="w-4 h-4 absolute left-3 top-3.5 text-white/40" aria-hidden="true" />
            {/* FIX-WORKER-1 pass 4: id + autoComplete="email" (browser autofill) + inputMode email */}
            <input id="forgot-email" type="email" required value={email}
              onChange={(e) => { setEmail(e.target.value); clearErr(); }}
              autoComplete="email" inputMode="email"
              placeholder="seu@email.com"
              className="w-full px-10 py-2.5 rounded-lg bg-white/5 border border-white/10 focus:border-magenta focus:outline-none" />
          </div>
        </div>

        {/* FIX-WORKER-1 pass 4: role=alert + dismiss button (era estatico, dificil dispensar) */}
        {err && (
          <div role="alert" className="text-sm text-red-400 bg-red-500/10 p-3 rounded-lg flex items-center justify-between">
            <span>{err}</span>
            {/* FIX-WORKER-1 pass 492 (a11y paridade register pass 183 + QnaForm pass 489) */}
            <button type="button" onClick={() => setErr('')}
              aria-label="Fechar mensagem de erro"
              className="text-xs hover:underline focus-visible:outline-2 focus-visible:outline-red-400 rounded">fechar</button>
          </div>
        )}

        {/* FIX-WORKER-1 pass 549 (a11y CTA paridade pass 121 add-to-cart + pass 537 compare-drawer):
            PRE-FIX BUG: submit button sem aria-busy/aria-label/focus-visible.
            - Sem aria-busy: SR nao anunciava 'busy' durante request
            - Sem aria-label: SR lia label estatico 'Enviar link de recuperacao'
              mesmo quando state era 'Enviando...' (state out-of-sync)
            - Sem focus-visible: keyboard users sem affordance ao tabular
            - Padrao W1 AUTH a11y consolidacao authflows.
            POST-FIX: aria-busy={loading} + aria-label dinamico + focus-visible
            outline magenta paridade pass 537 compare-drawer CTA. */}
        <button type="submit" disabled={loading}
          aria-busy={loading}
          aria-label={loading ? 'Enviando link de recuperacao de senha' : 'Enviar link de recuperacao de senha por email'}
          className="btn-primary w-full disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-magenta">
          {loading ? 'Enviando...' : 'Enviar link de recuperacao'}
        </button>

        <div className="text-center text-sm text-white/50">
          {/* FIX pass 549: focus-visible outline magenta nos secondary links (a11y kbd nav) */}
          <Link href="/login"
            className="text-magenta hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-magenta rounded">
            Voltar ao login
          </Link>
        </div>
      </form>
    </div>
  );
}
