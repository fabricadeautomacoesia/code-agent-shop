'use client';

export const dynamic = 'force-dynamic';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Lock, CheckCircle } from 'lucide-react';
import { Api } from '@/lib/api';

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
    if (!/[A-Z]/.test(password) || !/[0-9]/.test(password)) { setErr('Senha precisa de maiuscula e numero'); return; }
    setLoading(true);
    try {
      await Api.api('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, password }) });
      setDone(true);
      setTimeout(() => router.push('/login'), 2500);
    } catch (e: any) {
      setErr(e.data?.message || e.message);
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
        <CheckCircle className="w-16 h-16 mx-auto mb-4 text-green-400" />
        <h1 className="font-display font-bold text-2xl mb-3">Senha redefinida!</h1>
        <p className="text-white/70">Redirecionando para login...</p>
      </div>
    </div>
  );

  const pwColors = ['#ef4444','#f59e0b','#eab308','#22c55e'];
  const pwWidths = ['25%','50%','75%','100%'];

  return (
    <div className="container mx-auto px-6 py-16 max-w-md">
      <h1 className="font-display font-bold text-4xl mb-2">Nova senha</h1>
      <p className="text-white/60 mb-8">Defina uma nova senha forte</p>

      <form onSubmit={submit} className="glass p-8 space-y-5">
        <div>
          <label className="text-sm text-white/70 mb-1.5 block">Nova senha</label>
          <div className="relative">
            <Lock className="w-4 h-4 absolute left-3 top-3.5 text-white/40" />
            <input type="password" required value={password} onChange={(e) => onPass(e.target.value)}
              className="w-full px-10 py-2.5 rounded-lg bg-white/5 border border-white/10 focus:border-magenta focus:outline-none" />
          </div>
          <div className="mt-2 h-1.5 bg-white/5 rounded-full overflow-hidden">
            <div className="h-full transition-all" style={{
              width: password.length > 0 ? (pwWidths[pwScore-1] || '10%') : '0',
              background: password.length > 0 ? (pwColors[pwScore-1] || '#ef4444') : 'transparent',
            }} />
          </div>
        </div>
        <div>
          <label className="text-sm text-white/70 mb-1.5 block">Confirmar senha</label>
          <input type="password" required value={confirm} onChange={(e) => setConfirm(e.target.value)}
            className="w-full px-3 py-2.5 rounded-lg bg-white/5 border border-white/10 focus:border-magenta focus:outline-none" />
        </div>

        {err && <div className="text-sm text-red-400 bg-red-500/10 p-3 rounded-lg">{err}</div>}

        <button type="submit" disabled={loading} className="btn-primary w-full disabled:opacity-50">
          {loading ? 'Salvando...' : 'Redefinir senha'}
        </button>
      </form>
    </div>
  );
}
