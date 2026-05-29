'use client';

import { useCallback, useEffect, useState } from 'react';
import { sellerFetch } from '@/lib/seller-api';
import { useSellerAction } from '@/lib/use-seller-action';
import { Save, Shield } from 'lucide-react';

export default function LojaPage() {
  const [form, setForm] = useState({
    store_name: '', store_description: '',
    store_banner_url: '', store_logo_url: '',
    asaas_pix_key: '', allow_platform_resale: true,
  });
  const [kyc, setKyc] = useState({
    document_type: 'cpf', document_number: '', legal_name: '',
    address_line1: '', address_city: '', address_state: '', address_zip: '',
  });
  const [status, setStatus] = useState<string>('');
  const [loadError, setLoadError] = useState('');

  /* FIX-WORKER-5 pass 741 (useCallback stable closure - paridade pass 738/739/740 cadeia 4 sites):
     PRE-FIX BUG: async function load() recriada cada render.
     - useSellerAction(load) recebe nova reference cada render
     - useCallback dentro de useSellerAction tem deps [busyKey, reload]
       -> reload muda cada render -> `run` re-criada per render
     - useEffect deps [] ignora load completamente (mount-only intentional)
     - useSellerAction reload stale per render race window
     POST-FIX (paridade cadeia W4 738/739 + W5 740 + 741 este):
     - useCallback wrap em load com [] deps -> stable reference (sem state externo dependente)
     - useSellerAction recebe stable callback -> action.run estavel
     - useEffect deps [load] - paridade ESLint exhaustive-deps
     Pattern V8 React stability cadeia 4 sites cross-dashboard. */
  const load = useCallback(async () => {
    try {
      const r = await sellerFetch<{ seller: any }>('/sellers/me');
      const s = r.seller;
      setForm({
        store_name: s.store_name || '',
        store_description: s.store_description || '',
        store_banner_url: s.store_banner_url || '',
        store_logo_url: s.store_logo_url || '',
        asaas_pix_key: s.asaas_pix_key || '',
        allow_platform_resale: s.allow_platform_resale ?? true,
      });
      setStatus(s.status);
      setLoadError('');
    } catch (e: any) { setLoadError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // FIX-WORKER-5 pass 3: useSellerAction hook unifica feedback save + KYC
  const action = useSellerAction(load);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    action.run('save-profile', async () => {
      await sellerFetch('/sellers/me', { method: 'PATCH', body: JSON.stringify(form) });
      return 'Perfil da loja atualizado';
    });
  }

  async function submitKyc(e: React.FormEvent) {
    e.preventDefault();
    /* FIX-WORKER-5 pass 297: validacao client-side KYC pre-roundtrip.
       PRE-FIX: form valida apenas required HTML5. document_number/UF/CEP
       enviavam strings invalidas -> backend 400 -> UX confuso.
       POST-FIX paridade register pass 294:
       - document_number: 11 digitos (CPF) OU 14 digitos (CNPJ) strict
       - address_state: 2 letras [A-Z] (UF brasileiro)
       - address_zip: 8 digitos numericos (CEP) */
    const docDigits = kyc.document_number.replace(/\D/g, '');
    const expectedDocLen = kyc.document_type === 'cpf' ? 11 : 14;
    if (docDigits.length !== expectedDocLen) {
      action.run('submit-kyc', async () => {
        throw new Error(`${kyc.document_type === 'cpf' ? 'CPF' : 'CNPJ'} invalido: use ${expectedDocLen} digitos (voce digitou ${docDigits.length}).`);
      });
      return;
    }
    if (!/^[A-Z]{2}$/.test(kyc.address_state)) {
      action.run('submit-kyc', async () => {
        throw new Error('UF invalido: use 2 letras maiusculas (ex: SP, RJ, MG).');
      });
      return;
    }
    const zipDigits = kyc.address_zip.replace(/\D/g, '');
    if (zipDigits.length !== 8) {
      action.run('submit-kyc', async () => {
        throw new Error(`CEP invalido: use 8 digitos (voce digitou ${zipDigits.length}).`);
      });
      return;
    }
    action.run('submit-kyc', async () => {
      await sellerFetch('/sellers/me/kyc', {
        method: 'POST',
        body: JSON.stringify({
          ...kyc,
          document_number: docDigits,
          address_zip: zipDigits,
        }),
      });
      return 'KYC enviado com sucesso. Sua loja sera ativada apos validacao admin.';
    });
  }

  return (
    <div className="max-w-3xl">
      <h1 className="font-display font-bold text-4xl mb-2">Minha loja</h1>
      <p className="text-white/60 mb-2">Status atual: <span className="px-2 py-0.5 rounded bg-white/10 text-xs">{status}</span></p>
      <p className="text-white/60 mb-8">Personalize sua loja e dados de pagamento.</p>

      {/* FIX-WORKER-5 pass 3: banners centralizados (era inline no form rodape) */}
      {/* FIX-WORKER-5 pass 263 (a11y parity): loadError sem role=alert
          enquanto action.error/success ja tem. Pattern V8 consolidado
          passes 240 (financeiro), 248 (qna), agora 263 (loja).
          Screen reader nao anunciava falha de load KYC/profile - UX confuso
          (page parece vazia sem feedback). */}
      {loadError && (
        <div role="alert" className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4">
          Erro carregando dados: {loadError}
        </div>
      )}
      {/* FIX-WORKER-5 pass 172 (a11y V8 R23) */}
      {action.error && (
        <div role="alert" className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4 flex items-center justify-between">
          <span>{action.error}</span>
          <button type="button" onClick={action.clear} aria-label="Fechar mensagem de erro"
            className="text-xs hover:underline focus-visible:outline-2 focus-visible:outline-red-400 rounded">fechar</button>
        </div>
      )}
      {action.success && (
        <div role="status" aria-live="polite" className="bg-green-500/10 border border-green-500/30 text-green-400 p-4 rounded-lg mb-4 flex items-center justify-between">
          <span>{action.success}</span>
          <button type="button" onClick={action.clear} aria-label="Fechar mensagem de sucesso"
            className="text-xs hover:underline focus-visible:outline-2 focus-visible:outline-green-400 rounded">fechar</button>
        </div>
      )}

      {status === 'pending_kyc' && (
        <section className="glass p-6 mb-6 border-l-4 border-yellow-500">
          <h3 className="font-display font-bold text-xl mb-3 flex items-center gap-2">
            <Shield className="w-5 h-5 text-yellow-400" /> KYC pendente
          </h3>
          <p className="text-sm text-white/70 mb-4">Complete o KYC para ativar sua loja e poder publicar produtos.</p>
          {/* FIX-WORKER-5 pass 146 (a11y): KYC form 9 inputs htmlFor + id (WCAG 1.3.1)
              + autoComplete (browser autofill from registro CPF/endereco)
              + inputMode mobile-friendly (numeric p/ doc/CEP, text p/ outros) */}
          <form onSubmit={submitKyc} className="space-y-3">
            <div className="grid md:grid-cols-2 gap-3">
              <div>
                <label htmlFor="kyc-doctype" className="text-xs text-white/60 uppercase">Tipo</label>
                <select id="kyc-doctype" value={kyc.document_type} onChange={(e) => setKyc({...kyc, document_type: e.target.value})}
                  className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm">
                  <option value="cpf">CPF</option><option value="cnpj">CNPJ</option>
                </select>
              </div>
              {/* FIX-WORKER-5 pass 379 (maxLength alinhado backend Zod kycSchema):
                  PRE-FIX: 4 inputs KYC sem maxLength (apenas state com maxLength=2)
                  Backend Zod limits:
                  - document_number max(20) | legal_name max(200) | address_line1 max(200)
                  - address_city max(100) | address_state length(2) | address_zip max(20)
                  Pre-fix: user digita 5000 chars no endereco -> backend 400 Zod
                  errorHandler retorna mensagem generica - UX confuso (sem hint cap).
                  POST-FIX: HTML5 maxLength + minLength paridade backend = fail-fast UX */}
              <div>
                <label htmlFor="kyc-docnum" className="text-xs text-white/60 uppercase">Documento</label>
                <input id="kyc-docnum" value={kyc.document_number} onChange={(e) => setKyc({...kyc, document_number: e.target.value})} required
                  autoComplete="off" inputMode="numeric"
                  maxLength={20} minLength={11}
                  className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm" />
              </div>
            </div>
            <div>
              <label htmlFor="kyc-legal" className="text-xs text-white/60 uppercase">Razao social / nome completo</label>
              <input id="kyc-legal" value={kyc.legal_name} onChange={(e) => setKyc({...kyc, legal_name: e.target.value})} required
                autoComplete="name"
                maxLength={200} minLength={3}
                className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm" />
            </div>
            <div>
              <label htmlFor="kyc-addr1" className="sr-only">Endereco</label>
              <input id="kyc-addr1" placeholder="Endereco" value={kyc.address_line1} onChange={(e) => setKyc({...kyc, address_line1: e.target.value})} required
                autoComplete="street-address"
                aria-label="Endereco"
                maxLength={200} minLength={3}
                className="w-full px-3 py-2 rounded bg-white/5 border border-white/10 text-sm" />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label htmlFor="kyc-city" className="sr-only">Cidade</label>
                <input id="kyc-city" placeholder="Cidade" value={kyc.address_city} onChange={(e) => setKyc({...kyc, address_city: e.target.value})} required
                  autoComplete="address-level2" aria-label="Cidade"
                  maxLength={100} minLength={2}
                  className="w-full px-3 py-2 rounded bg-white/5 border border-white/10 text-sm" />
              </div>
              <div>
                <label htmlFor="kyc-state" className="sr-only">UF</label>
                <input id="kyc-state" placeholder="UF" maxLength={2} value={kyc.address_state} onChange={(e) => setKyc({...kyc, address_state: e.target.value.toUpperCase()})} required
                  autoComplete="address-level1" aria-label="Estado UF"
                  className="w-full px-3 py-2 rounded bg-white/5 border border-white/10 text-sm" />
              </div>
              <div>
                <label htmlFor="kyc-zip" className="sr-only">CEP</label>
                <input id="kyc-zip" placeholder="CEP" value={kyc.address_zip} onChange={(e) => setKyc({...kyc, address_zip: e.target.value})} required
                  autoComplete="postal-code" inputMode="numeric" aria-label="CEP"
                  maxLength={20} minLength={5}
                  className="w-full px-3 py-2 rounded bg-white/5 border border-white/10 text-sm" />
              </div>
            </div>
            <button type="submit" disabled={action.busyKey === 'submit-kyc'}
              className="btn-primary disabled:opacity-50 disabled:cursor-wait">
              {action.busyKey === 'submit-kyc' ? 'Enviando KYC...' : 'Enviar KYC'}
            </button>
          </form>
        </section>
      )}

      <form onSubmit={save} className="space-y-6">
        <section className="glass p-6 space-y-4">
          <h3 className="font-display font-bold text-lg">Identidade da loja</h3>
          {/* FIX-WORKER-5 pass 337: maxLength alinhado com backend Zod (paridade pass 330/331).
              Backend updateSchema:
              - store_name max(120) | store_description max(5000)
              - store_banner_url + store_logo_url max(2048)
              - asaas_pix_key max(200) */}
          <div>
            <label htmlFor="loja-name" className="text-xs text-white/60 uppercase">Nome da loja</label>
            <input id="loja-name" value={form.store_name} onChange={(e) => setForm({...form, store_name: e.target.value})}
              autoComplete="organization" maxLength={120} minLength={3}
              className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm" />
          </div>
          <div>
            <label htmlFor="loja-desc" className="text-xs text-white/60 uppercase">Descricao</label>
            <textarea id="loja-desc" value={form.store_description} onChange={(e) => setForm({...form, store_description: e.target.value})} rows={4}
              maxLength={5000}
              className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm" />
            <div className={`text-[10px] text-right mt-1 ${
              (form.store_description?.length || 0) > 4750 ? 'text-yellow-400' : 'text-white/30'
            }`}>{form.store_description?.length || 0}/5000</div>
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <label htmlFor="loja-banner" className="text-xs text-white/60 uppercase">URL banner</label>
              <input id="loja-banner" type="url" inputMode="url" maxLength={2048} value={form.store_banner_url} onChange={(e) => setForm({...form, store_banner_url: e.target.value})}
                className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm font-mono text-xs" />
            </div>
            <div>
              <label htmlFor="loja-logo" className="text-xs text-white/60 uppercase">URL logo</label>
              <input id="loja-logo" type="url" inputMode="url" maxLength={2048} value={form.store_logo_url} onChange={(e) => setForm({...form, store_logo_url: e.target.value})}
                className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm font-mono text-xs" />
            </div>
          </div>
        </section>

        <section className="glass p-6 space-y-4">
          <h3 className="font-display font-bold text-lg">Pagamento Asaas</h3>
          <div>
            <label htmlFor="loja-pix" className="text-xs text-white/60 uppercase">Chave PIX</label>
            <input id="loja-pix" value={form.asaas_pix_key} onChange={(e) => setForm({...form, asaas_pix_key: e.target.value})}
              autoComplete="off" maxLength={200}
              className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm font-mono" />
          </div>
          {/* FIX-WORKER-5 pass 502 (a11y checkbox htmlFor/id + focus-visible + aria-describedby):
              PRE-FIX (3 issues):
              1. <label> sem htmlFor + <input> sem id - inconsistencia com TODOS outros
                 inputs neste file (linhas 138, 153, 162, 169, 178, 184, 190, 214, 220, 231, 236, 245)
                 que usam htmlFor + id explicit binding (paridade pass 146 a11y W5).
              2. Sem focus-visible:outline - keyboard nav perde foco em dark mode
                 (paridade pass 492 W1 + pass 496 W5 dismiss buttons).
              3. Sem aria-describedby p/ help text spans - SR le label mas perde context
                 que e Clausula Master (compliance impact se desativado).
              POST-FIX:
              - id="loja-resale" + htmlFor binding explicit
              - help text id="loja-resale-help" + aria-describedby
              - focus-visible:outline-2 outline-magenta + rounded
              Bonus: cursor-pointer no label visualmente afford clicavel.
              Pattern V8 W5/W1 a11y consolidacao: checkboxes precisam mesma paridade. */}
          <label htmlFor="loja-resale" className="flex items-start gap-3 text-sm cursor-pointer">
            <input type="checkbox" id="loja-resale" checked={form.allow_platform_resale}
              onChange={(e) => setForm({...form, allow_platform_resale: e.target.checked})}
              aria-describedby="loja-resale-help"
              className="mt-0.5 focus-visible:outline-2 focus-visible:outline-magenta rounded" />
            <span id="loja-resale-help" className="text-white/70">
              Permitir Revenda Direta pela plataforma (Clausula Master). Desativar impede que CAS venda copias do seu produto sem comissao.
            </span>
          </label>
        </section>

        {/* FIX-WORKER-5 pass 3: banners movidos para o topo (centralizados action hook) */}
        <button type="submit" disabled={action.busyKey === 'save-profile'}
          className="btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-wait">
          <Save className="w-4 h-4" /> {action.busyKey === 'save-profile' ? 'Salvando...' : 'Salvar'}
        </button>
      </form>
    </div>
  );
}
