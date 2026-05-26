'use client';

export const dynamic = 'force-dynamic';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Api } from '@/lib/api';
import { useAuth } from '@/lib/store';

export default function LoginPage() {
  const router = useRouter();
  const setAuth = useAuth((s) => s.setAuth);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needs2fa, setNeeds2fa] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      const r: any = await Api.login(email, password, needs2fa ? totp : undefined);
      if (r.requires_2fa) { setNeeds2fa(true); setLoading(false); return; }
      setAuth(r.access_token, r.user);
      router.push('/conta');
    } catch (err: any) {
      setError(err.data?.message || err.message);
    } finally { setLoading(false); }
  }

  return (
    <div className="container mx-auto px-6 py-16 max-w-md">
      <h1 className="font-display font-bold text-4xl mb-2">Entrar</h1>
      <p className="text-white/60 mb-8">Acesse sua conta no Code & Agent Shop</p>

      <form onSubmit={submit} className="glass p-8 space-y-5">
        {!needs2fa ? (
          <>
            <div>
              <label className="text-sm text-white/70 mb-1.5 block">Email</label>
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 focus:border-magenta focus:outline-none" />
            </div>
            <div>
              <label className="text-sm text-white/70 mb-1.5 block">Senha</label>
              <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 focus:border-magenta focus:outline-none" />
            </div>
          </>
        ) : (
          <div>
            <label className="text-sm text-white/70 mb-1.5 block">Codigo 2FA (6 digitos)</label>
            <input type="text" required maxLength={6} value={totp} onChange={(e) => setTotp(e.target.value)}
              className="w-full px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 focus:border-magenta focus:outline-none text-center text-2xl font-mono tracking-widest" />
          </div>
        )}

        {error && <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg p-3">{error}</div>}

        <button type="submit" disabled={loading} className="btn-primary w-full disabled:opacity-50">
          {loading ? 'Entrando...' : (needs2fa ? 'Validar 2FA' : 'Entrar')}
        </button>

        <div className="text-center text-sm text-white/50">
          Nao tem conta?{' '}
          <Link href="/register" className="text-magenta hover:underline">Cadastre-se</Link>
        </div>
      </form>
    </div>
  );
}
