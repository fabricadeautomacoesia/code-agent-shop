'use client';

export const dynamic = 'force-dynamic';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Api } from '@/lib/api';
import { friendlyAuthError } from '@/lib/auth-errors';

export default function RegisterPage() {
  return <Suspense fallback={<div className="container mx-auto px-6 py-16 max-w-md">Carregando...</div>}><RegisterInner /></Suspense>;
}

function RegisterInner() {
  const router = useRouter();
  const sp = useSearchParams();
  const initialRole = (sp.get('role') as 'buyer'|'seller') || 'buyer';
  const [role, setRole] = useState<'buyer'|'seller'>(initialRole);
  const [form, setForm] = useState({ email: '', password: '', full_name: '', cpf_cnpj: '', phone_e164: '' });
  const [pwScore, setPwScore] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  function onPass(v: string) {
    setForm({ ...form, password: v });
    let s = 0;
    if (v.length >= 8) s++;
    if (/[A-Z]/.test(v)) s++;
    if (/[0-9]/.test(v)) s++;
    if (/[!@#$%^&*]/.test(v)) s++;
    setPwScore(s);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    // FIX-WORKER-1 pass 2: validacao client-side preventiva evita roundtrip + UX confuso
    if (form.phone_e164 && !/^\+[1-9]\d{6,14}$/.test(form.phone_e164)) {
      setError('Telefone: use formato internacional +5511999999999 (com codigo do pais).');
      return;
    }
    if (form.cpf_cnpj && !/^\d{11,14}$/.test(form.cpf_cnpj.replace(/\D/g, ''))) {
      setError('CPF/CNPJ: digite apenas numeros, 11 ou 14 digitos.');
      return;
    }
    setLoading(true);
    try {
      // CPF/CNPJ: normaliza removendo pontuacao antes de enviar
      const payload = {
        ...form,
        role,
        cpf_cnpj: form.cpf_cnpj ? form.cpf_cnpj.replace(/\D/g, '') : '',
      };
      await Api.register(payload);
      router.push('/login?registered=1');
    } catch (err: any) {
      setError(friendlyAuthError(err));
    } finally { setLoading(false); }
  }

  const pwColors = ['#ef4444','#f59e0b','#eab308','#22c55e'];
  const pwWidths = ['25%','50%','75%','100%'];

  return (
    <div className="container mx-auto px-6 py-16 max-w-md">
      <h1 className="font-display font-bold text-4xl mb-2">Criar conta</h1>
      <p className="text-white/60 mb-8">
        {role === 'seller' ? 'Comece a vender suas automacoes e agentes IA' : 'Acesse o maior marketplace de automacoes'}
      </p>

      <div className="flex gap-2 mb-6">
        <button onClick={() => setRole('buyer')} type="button"
          className={`flex-1 py-2 rounded-lg text-sm font-medium ${role==='buyer' ? 'bg-gradient-vibe text-white' : 'glass'}`}>
          Comprador
        </button>
        <button onClick={() => setRole('seller')} type="button"
          className={`flex-1 py-2 rounded-lg text-sm font-medium ${role==='seller' ? 'bg-gradient-vibe text-white' : 'glass'}`}>
          Vendedor
        </button>
      </div>

      <form onSubmit={submit} className="glass p-8 space-y-5">
        {/* FIX-WORKER-1 pass 139 (a11y): 5 labels c/ htmlFor + 5 inputs c/ id (WCAG 1.3.1)
            + autoComplete proper + inputMode mobile keyboard adequado.
            ANTES: <label> sem htmlFor + <input> sem id -> SR desassociava.
            AGORA: WAI-ARIA forms pattern + browser autofill correto. */}
        <div>
          <label htmlFor="reg-fullname" className="text-sm text-white/70 mb-1.5 block">Nome completo</label>
          <input id="reg-fullname" required value={form.full_name} onChange={(e) => setForm({...form, full_name: e.target.value})}
            autoComplete="name" type="text"
            className="w-full px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 focus:border-magenta focus:outline-none" />
        </div>
        <div>
          <label htmlFor="reg-email" className="text-sm text-white/70 mb-1.5 block">Email</label>
          <input id="reg-email" type="email" required value={form.email} onChange={(e) => setForm({...form, email: e.target.value})}
            autoComplete="email" inputMode="email"
            className="w-full px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 focus:border-magenta focus:outline-none" />
        </div>
        <div>
          <label htmlFor="reg-password" className="text-sm text-white/70 mb-1.5 block">Senha (min 8, com maiuscula e numero)</label>
          <input id="reg-password" type="password" required value={form.password} onChange={(e) => onPass(e.target.value)}
            autoComplete="new-password" aria-describedby="reg-pw-strength"
            className="w-full px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 focus:border-magenta focus:outline-none" />
          {/* Barra de forca de senha V8 23.11
              FIX-WORKER-1 pass 139: progressbar role + aria-valuenow p/ SR + aria-live */}
          <div id="reg-pw-strength" className="mt-2 h-1.5 bg-white/5 rounded-full overflow-hidden"
            role="progressbar" aria-valuemin={0} aria-valuemax={4} aria-valuenow={pwScore}
            aria-label={form.password.length > 0 ? `Forca da senha: ${pwScore} de 4` : 'Forca da senha (digite a senha)'}>
            <div className="h-full transition-all" style={{
              width: form.password.length > 0 ? (pwWidths[pwScore-1] || '10%') : '0',
              background: form.password.length > 0 ? (pwColors[pwScore-1] || '#ef4444') : 'transparent',
            }} />
          </div>
        </div>
        <div>
          <label htmlFor="reg-cpfcnpj" className="text-sm text-white/70 mb-1.5 block">CPF/CNPJ {role==='buyer' && <span className="text-white/40">(opcional)</span>}</label>
          <input id="reg-cpfcnpj" value={form.cpf_cnpj} onChange={(e) => setForm({...form, cpf_cnpj: e.target.value})}
            autoComplete="off" inputMode="numeric"
            placeholder="000.000.000-00 ou 00.000.000/0000-00"
            className="w-full px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 focus:border-magenta focus:outline-none" />
        </div>
        <div>
          <label htmlFor="reg-phone" className="text-sm text-white/70 mb-1.5 block">Telefone E.164 (+5511...)</label>
          <input id="reg-phone" type="tel" value={form.phone_e164} onChange={(e) => setForm({...form, phone_e164: e.target.value})}
            autoComplete="tel" inputMode="tel"
            placeholder="+5511999999999"
            className="w-full px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 focus:border-magenta focus:outline-none" />
        </div>

        {role === 'seller' && (
          <div className="text-xs text-white/50 bg-magenta/10 border border-magenta/20 rounded-lg p-3">
            Ao criar conta como vendedor voce concorda com os <Link href="/termos" className="text-magenta underline">Termos de Uso</Link>,
            incluindo a Clausula Master de Revenda Direta da plataforma e o pipeline QA automatizado.
          </div>
        )}

        {error && <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg p-3">{error}</div>}

        <button type="submit" disabled={loading} className="btn-primary w-full disabled:opacity-50">
          {loading ? 'Criando conta...' : 'Criar conta'}
        </button>

        <div className="text-center text-sm text-white/50">
          Ja tem conta? <Link href="/login" className="text-magenta hover:underline">Entrar</Link>
        </div>
      </form>
    </div>
  );
}
