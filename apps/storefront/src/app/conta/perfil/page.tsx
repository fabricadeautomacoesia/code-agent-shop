'use client';

/**
 * FIX-WORKER-1 pass 3: Form de perfil em /conta/perfil
 *
 * W2 pass 4 banner /checkout redireciona para /conta. Mas /conta era so
 * dashboard - nao tinha forma de EDITAR cpf/phone/nome. Esta page completa
 * o flow: user vai para /checkout sem CPF -> banner -> /conta -> "Editar
 * perfil" -> /conta/perfil -> preenche CPF -> volta /checkout.
 *
 * Mascara CPF/CNPJ automatica (UX MLB-style).
 * Validacao client-side com mesmo algoritmo do auth-svc/me.js.
 * Backend re-valida (defense em depth).
 */

export const dynamic = 'force-dynamic';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CheckCircle, User } from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth } from '@/lib/store';
import { friendlyAuthError } from '@/lib/auth-errors';

// CPF/CNPJ algoritmo client-side (mesmo do backend W2 pass 5)
function isValidCpf(s: string): boolean {
  s = s.replace(/\D/g, '');
  if (s.length !== 11 || /^(\d)\1+$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(s[i], 10) * (10 - i);
  let dv1 = (sum * 10) % 11; if (dv1 === 10) dv1 = 0;
  if (dv1 !== parseInt(s[9], 10)) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(s[i], 10) * (11 - i);
  let dv2 = (sum * 10) % 11; if (dv2 === 10) dv2 = 0;
  return dv2 === parseInt(s[10], 10);
}
function isValidCnpj(s: string): boolean {
  s = s.replace(/\D/g, '');
  if (s.length !== 14 || /^(\d)\1+$/.test(s)) return false;
  const calc = (slice: string) => {
    let sum = 0, pos = slice.length - 7;
    for (let i = slice.length; i >= 1; i--) {
      sum += parseInt(slice[slice.length - i], 10) * pos--;
      if (pos < 2) pos = 9;
    }
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  if (calc(s.slice(0, 12)) !== parseInt(s[12], 10)) return false;
  return calc(s.slice(0, 13)) === parseInt(s[13], 10);
}

function maskCpfCnpj(s: string): string {
  const d = s.replace(/\D/g, '').slice(0, 14);
  if (d.length <= 11) {
    // CPF: 000.000.000-00
    return d
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
      .replace(/(\d{3})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3-$4');
  }
  // CNPJ: 00.000.000/0000-00
  return d
    .replace(/(\d{2})(\d)/, '$1.$2')
    .replace(/(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/(\d{2})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3/$4')
    .replace(/(\d{2})\.(\d{3})\.(\d{3})\/(\d{4})(\d)/, '$1.$2.$3/$4-$5');
}

export default function PerfilPage() {
  const router = useRouter();
  const { token } = useAuth();
  const [me, setMe] = useState<any>(null);
  const [full_name, setFullName] = useState('');
  const [cpf_cnpj, setCpf] = useState('');
  const [phone_e164, setPhone] = useState('');
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!token) { router.push('/login'); return; }
    Api.me(token).then((r: any) => {
      setMe(r.user);
      setFullName(r.user.full_name || '');
      setCpf(r.user.cpf_cnpj ? maskCpfCnpj(r.user.cpf_cnpj) : '');
      setPhone(r.user.phone_e164 || '');
    }).catch(() => {});
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(''); setOk('');
    // Validacao client-side
    const cpfDigits = cpf_cnpj.replace(/\D/g, '');
    if (cpfDigits) {
      if (cpfDigits.length === 11 && !isValidCpf(cpfDigits)) {
        setErr('CPF invalido (verifique os digitos)'); return;
      }
      if (cpfDigits.length === 14 && !isValidCnpj(cpfDigits)) {
        setErr('CNPJ invalido (verifique os digitos)'); return;
      }
      if (cpfDigits.length !== 11 && cpfDigits.length !== 14) {
        setErr('CPF precisa ter 11 digitos ou CNPJ 14 digitos'); return;
      }
    }
    if (phone_e164 && !/^\+[1-9]\d{6,14}$/.test(phone_e164)) {
      setErr('Telefone: use formato internacional +5511999999999'); return;
    }
    setLoading(true);
    try {
      await Api.api('/auth/me', {
        method: 'PATCH', auth: token!,
        body: JSON.stringify({ full_name, cpf_cnpj: cpfDigits || undefined, phone_e164: phone_e164 || undefined }),
      });
      setOk('Perfil atualizado com sucesso!');
      // Pequeno delay UX + redirect opcional
      setTimeout(() => router.push('/conta'), 1500);
    } catch (e: any) {
      setErr(friendlyAuthError(e));
    } finally { setLoading(false); }
  }

  if (!me) return <div className="container mx-auto px-6 py-16 text-center text-white/60">Carregando...</div>;

  return (
    <div className="container mx-auto px-6 py-8 max-w-2xl">
      <Link href="/conta" className="text-sm text-white/60 hover:text-white">&larr; Minha conta</Link>
      <div className="flex items-center gap-3 mt-4 mb-8">
        <User className="w-8 h-8 text-magenta" />
        <h1 className="font-display font-bold text-3xl">Editar perfil</h1>
      </div>

      <form onSubmit={submit} className="glass p-6 md:p-8 space-y-5">
        <div>
          <label className="text-sm text-white/70 mb-1.5 block">Email</label>
          <input type="email" value={me.email} disabled
            className="w-full px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 text-white/50 cursor-not-allowed" />
          <p className="text-xs text-white/40 mt-1">Email nao pode ser alterado por seguranca.</p>
        </div>

        <div>
          <label className="text-sm text-white/70 mb-1.5 block">Nome completo</label>
          <input value={full_name} onChange={(e) => setFullName(e.target.value)} required
            className="w-full px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 focus:border-magenta focus:outline-none" />
        </div>

        <div>
          <label className="text-sm text-white/70 mb-1.5 block">
            CPF ou CNPJ {!me.cpf_cnpj && <span className="text-yellow-400 text-xs">- obrigatorio para pagamentos</span>}
          </label>
          <input value={cpf_cnpj} onChange={(e) => setCpf(maskCpfCnpj(e.target.value))}
            placeholder="000.000.000-00 ou 00.000.000/0000-00" maxLength={18}
            className="w-full px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 focus:border-magenta focus:outline-none font-mono" />
        </div>

        <div>
          <label className="text-sm text-white/70 mb-1.5 block">Telefone E.164 (opcional)</label>
          <input value={phone_e164} onChange={(e) => setPhone(e.target.value)}
            placeholder="+5511999999999"
            className="w-full px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 focus:border-magenta focus:outline-none" />
        </div>

        {err && <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg p-3">{err}</div>}
        {ok && (
          <div className="text-sm text-green-400 bg-green-500/10 border border-green-500/30 rounded-lg p-3 flex items-center gap-2">
            <CheckCircle className="w-4 h-4" /> {ok}
          </div>
        )}

        <button type="submit" disabled={loading} className="btn-primary w-full disabled:opacity-50">
          {loading ? 'Salvando...' : 'Salvar alteracoes'}
        </button>
      </form>
    </div>
  );
}
