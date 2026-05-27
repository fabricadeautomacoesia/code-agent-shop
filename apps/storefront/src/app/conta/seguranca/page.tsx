'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shield, Smartphone, AlertCircle, CheckCircle, Copy } from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth } from '@/lib/store';
import { friendlyAuthError } from '@/lib/auth-errors';

export default function SegurancaPage() {
  const router = useRouter();
  const { token } = useAuth();
  const [me, setMe] = useState<any>(null);
  // FIX-WORKER-6 pass 1: novo state twofaStatus separado de me.twofa_enabled
  // para refletir has_pending_setup (segredo em DB mas nao ativado ainda).
  const [twofaStatus, setTwofaStatus] = useState<{ enabled: boolean; has_pending_setup: boolean; recovery_count: number } | null>(null);
  const [setupData, setSetupData] = useState<any>(null);
  const [token2fa, setToken2fa] = useState('');
  const [password, setPassword] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [loading, setLoading] = useState(false);

  async function refreshStatus() {
    if (!token) return;
    try {
      const s: any = await Api.api('/auth/2fa/status', { auth: token });
      setTwofaStatus(s);
    } catch {}
  }

  useEffect(() => {
    if (!token) { router.push('/login'); return; }
    Api.me(token).then((r) => setMe(r.user)).catch(() => {});
    refreshStatus();
  }, [token]);

  async function startSetup() {
    setLoading(true); setError('');
    try {
      const r: any = await Api.api('/auth/2fa/setup', { method: 'POST', auth: token! });
      setSetupData(r);
    } catch (e: any) { setError(friendlyAuthError(e)); }
    finally { setLoading(false); }
  }

  async function activate() {
    setLoading(true); setError(''); setOk('');
    try {
      const r: any = await Api.api('/auth/2fa/activate', { method: 'POST', auth: token!, body: JSON.stringify({ token: token2fa }) });
      setRecoveryCodes(r.recovery_codes);
      setSetupData(null);
      setOk('2FA ativado com sucesso! Salve os codigos de recuperacao.');
      setToken2fa('');
      Api.me(token!).then((m) => setMe(m.user));
      refreshStatus();
    } catch (e: any) { setError(friendlyAuthError(e)); }
    finally { setLoading(false); }
  }

  async function disable() {
    setLoading(true); setError('');
    try {
      await Api.api('/auth/2fa/disable', { method: 'POST', auth: token!, body: JSON.stringify({ password, token: token2fa }) });
      setOk('2FA desativado.');
      setPassword(''); setToken2fa('');
      Api.me(token!).then((m) => setMe(m.user));
      refreshStatus();
    } catch (e: any) { setError(friendlyAuthError(e)); }
    finally { setLoading(false); }
  }

  if (!me) return <div className="container mx-auto px-6 py-16 text-center text-white/60">Carregando...</div>;

  return (
    <div className="container mx-auto px-6 py-8 max-w-2xl">
      <h1 className="font-display font-bold text-4xl mb-2">Seguranca</h1>
      <p className="text-white/60 mb-8">Proteja sua conta com 2FA (autenticacao em dois fatores)</p>

      <div className="glass p-6 mb-6">
        <div className="flex items-center gap-3 mb-4">
          <Shield className="w-8 h-8 text-magenta" />
          <div>
            <h2 className="font-display font-bold text-xl">2FA TOTP</h2>
            {/* FIX-WORKER-6 pass 1: usa twofaStatus (endpoint real) com fallback p/ me.twofa_enabled */}
            <div className="text-sm text-white/60">
              Status: {(twofaStatus?.enabled ?? me.twofa_enabled)
                ? <span className="text-green-400 font-semibold">Ativado</span>
                : twofaStatus?.has_pending_setup
                  ? <span className="text-orange-400 font-semibold">Setup pendente (escaneie o QR abaixo)</span>
                  : <span className="text-yellow-400">Desativado</span>}
              {twofaStatus?.enabled && twofaStatus.recovery_count > 0 && (
                <span className="ml-2 text-xs text-white/50">({twofaStatus.recovery_count} codigos de recuperacao restantes)</span>
              )}
            </div>
          </div>
        </div>

        {!(twofaStatus?.enabled ?? me.twofa_enabled) && !setupData && (
          <div>
            <div className="flex items-start gap-3 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg mb-4">
              <AlertCircle className="w-5 h-5 text-yellow-400 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-white/80">
                Sua conta esta com seguranca basica. Recomendamos ativar 2FA para proteger
                contra acesso nao autorizado.
              </p>
            </div>
            <button onClick={startSetup} disabled={loading} className="btn-primary disabled:opacity-50">
              {loading ? 'Gerando...' : 'Ativar 2FA'}
            </button>
          </div>
        )}

        {setupData && (
          <div className="space-y-4">
            <p className="text-sm text-white/80">
              1. Abra seu app autenticador (Google Authenticator, Authy, 1Password).<br />
              2. Escaneie o QR code abaixo:
            </p>
            <div className="bg-white p-4 rounded-lg inline-block">
              <img src={setupData.qr_data_url} alt="QR Code 2FA" className="w-48 h-48" />
            </div>
            <div>
              <div className="text-xs text-white/50 mb-1">Ou cole este codigo manual:</div>
              <div className="flex items-center gap-2">
                <code className="bg-white/5 px-3 py-2 rounded font-mono text-sm flex-1">{setupData.manual_code}</code>
                <button onClick={() => navigator.clipboard.writeText(setupData.manual_code)} className="p-2 hover:bg-white/5 rounded">
                  <Copy className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div>
              <label className="text-sm text-white/70 mb-1.5 block">3. Digite o codigo de 6 digitos gerado:</label>
              <input type="text" value={token2fa} onChange={(e) => setToken2fa(e.target.value)} maxLength={6}
                className="w-full px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 focus:border-magenta focus:outline-none text-center text-2xl font-mono tracking-widest" />
            </div>
            <button onClick={activate} disabled={loading || token2fa.length !== 6} className="btn-primary w-full disabled:opacity-50">
              {loading ? 'Ativando...' : 'Confirmar e ativar'}
            </button>
          </div>
        )}

        {recoveryCodes.length > 0 && (
          <div className="mt-6 p-4 bg-magenta/10 border border-magenta/30 rounded-lg">
            <div className="flex items-center gap-2 mb-3">
              <CheckCircle className="w-5 h-5 text-magenta" />
              <strong>Codigos de recuperacao (guarde em local seguro!)</strong>
            </div>
            <div className="grid grid-cols-2 gap-2 font-mono text-sm">
              {recoveryCodes.map((c) => (
                <div key={c} className="bg-black/30 px-3 py-2 rounded">{c}</div>
              ))}
            </div>
            <p className="text-xs text-white/60 mt-3">
              Cada codigo serve para 1 acesso caso voce perca o celular. Nao serao mostrados novamente.
            </p>
          </div>
        )}

        {(twofaStatus?.enabled ?? me.twofa_enabled) && !setupData && (
          <div className="space-y-3">
            <div className="flex items-start gap-3 p-3 bg-green-500/10 border border-green-500/30 rounded-lg">
              <Shield className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-white/80">Sua conta esta protegida com 2FA.</p>
            </div>
            <details className="text-sm">
              <summary className="cursor-pointer text-red-400 hover:underline">Desativar 2FA (requer senha + token)</summary>
              <div className="mt-3 space-y-2">
                <input type="password" placeholder="Senha atual" value={password} onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-3 py-2 rounded bg-white/5 border border-white/10 text-sm" />
                <input type="text" maxLength={6} placeholder="Codigo 2FA" value={token2fa} onChange={(e) => setToken2fa(e.target.value)}
                  className="w-full px-3 py-2 rounded bg-white/5 border border-white/10 text-sm text-center font-mono" />
                <button onClick={disable} disabled={loading} className="btn-ghost text-red-400 w-full disabled:opacity-50">
                  Confirmar desativacao
                </button>
              </div>
            </details>
          </div>
        )}

        {error && <div className="mt-4 text-sm text-red-400 bg-red-500/10 p-3 rounded">{error}</div>}
        {ok && <div className="mt-4 text-sm text-green-400 bg-green-500/10 p-3 rounded">{ok}</div>}
      </div>
    </div>
  );
}
