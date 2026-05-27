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
      await Api.api('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
      setSent(true);
    } catch (e: any) {
      setErr(friendlyAuthError(e));
    } finally { setLoading(false); }
  }

  if (sent) return (
    <div className="container mx-auto px-6 py-16 max-w-md">
      <div className="glass p-8 text-center">
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
        <Link href="/login" className="btn-primary inline-block">Voltar ao login</Link>
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
            <button type="button" onClick={() => setErr('')} className="text-xs hover:underline">fechar</button>
          </div>
        )}

        <button type="submit" disabled={loading} className="btn-primary w-full disabled:opacity-50">
          {loading ? 'Enviando...' : 'Enviar link de recuperacao'}
        </button>

        <div className="text-center text-sm text-white/50">
          <Link href="/login" className="text-magenta hover:underline">Voltar ao login</Link>
        </div>
      </form>
    </div>
  );
}
