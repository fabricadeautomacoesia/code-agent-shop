'use client';

import { useEffect, useState } from 'react';
import { sellerFetch } from '@/lib/seller-api';
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
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');

  async function load() {
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
    } catch (e: any) { setError(e.message); }
  }
  useEffect(() => { load(); }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setOk('');
    try {
      await sellerFetch('/sellers/me', { method: 'PATCH', body: JSON.stringify(form) });
      setOk('Salvo!');
    } catch (e: any) { setError(e.message); }
  }

  async function submitKyc(e: React.FormEvent) {
    e.preventDefault();
    try {
      await sellerFetch('/sellers/me/kyc', { method: 'POST', body: JSON.stringify(kyc) });
      setOk('KYC enviado. Status: active');
      load();
    } catch (e: any) { setError(e.message); }
  }

  return (
    <div className="max-w-3xl">
      <h1 className="font-display font-bold text-4xl mb-2">Minha loja</h1>
      <p className="text-white/60 mb-2">Status atual: <span className="px-2 py-0.5 rounded bg-white/10 text-xs">{status}</span></p>
      <p className="text-white/60 mb-8">Personalize sua loja e dados de pagamento.</p>

      {status === 'pending_kyc' && (
        <section className="glass p-6 mb-6 border-l-4 border-yellow-500">
          <h3 className="font-display font-bold text-xl mb-3 flex items-center gap-2">
            <Shield className="w-5 h-5 text-yellow-400" /> KYC pendente
          </h3>
          <p className="text-sm text-white/70 mb-4">Complete o KYC para ativar sua loja e poder publicar produtos.</p>
          <form onSubmit={submitKyc} className="space-y-3">
            <div className="grid md:grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-white/60 uppercase">Tipo</label>
                <select value={kyc.document_type} onChange={(e) => setKyc({...kyc, document_type: e.target.value})}
                  className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm">
                  <option value="cpf">CPF</option><option value="cnpj">CNPJ</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-white/60 uppercase">Documento</label>
                <input value={kyc.document_number} onChange={(e) => setKyc({...kyc, document_number: e.target.value})} required
                  className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm" />
              </div>
            </div>
            <div>
              <label className="text-xs text-white/60 uppercase">Razao social / nome completo</label>
              <input value={kyc.legal_name} onChange={(e) => setKyc({...kyc, legal_name: e.target.value})} required
                className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm" />
            </div>
            <input placeholder="Endereco" value={kyc.address_line1} onChange={(e) => setKyc({...kyc, address_line1: e.target.value})} required
              className="w-full px-3 py-2 rounded bg-white/5 border border-white/10 text-sm" />
            <div className="grid grid-cols-3 gap-3">
              <input placeholder="Cidade" value={kyc.address_city} onChange={(e) => setKyc({...kyc, address_city: e.target.value})} required
                className="px-3 py-2 rounded bg-white/5 border border-white/10 text-sm" />
              <input placeholder="UF" maxLength={2} value={kyc.address_state} onChange={(e) => setKyc({...kyc, address_state: e.target.value.toUpperCase()})} required
                className="px-3 py-2 rounded bg-white/5 border border-white/10 text-sm" />
              <input placeholder="CEP" value={kyc.address_zip} onChange={(e) => setKyc({...kyc, address_zip: e.target.value})} required
                className="px-3 py-2 rounded bg-white/5 border border-white/10 text-sm" />
            </div>
            <button type="submit" className="btn-primary">Enviar KYC</button>
          </form>
        </section>
      )}

      <form onSubmit={save} className="space-y-6">
        <section className="glass p-6 space-y-4">
          <h3 className="font-display font-bold text-lg">Identidade da loja</h3>
          <div>
            <label className="text-xs text-white/60 uppercase">Nome da loja</label>
            <input value={form.store_name} onChange={(e) => setForm({...form, store_name: e.target.value})}
              className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm" />
          </div>
          <div>
            <label className="text-xs text-white/60 uppercase">Descricao</label>
            <textarea value={form.store_description} onChange={(e) => setForm({...form, store_description: e.target.value})} rows={4}
              className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm" />
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-white/60 uppercase">URL banner</label>
              <input value={form.store_banner_url} onChange={(e) => setForm({...form, store_banner_url: e.target.value})}
                className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm font-mono text-xs" />
            </div>
            <div>
              <label className="text-xs text-white/60 uppercase">URL logo</label>
              <input value={form.store_logo_url} onChange={(e) => setForm({...form, store_logo_url: e.target.value})}
                className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm font-mono text-xs" />
            </div>
          </div>
        </section>

        <section className="glass p-6 space-y-4">
          <h3 className="font-display font-bold text-lg">Pagamento Asaas</h3>
          <div>
            <label className="text-xs text-white/60 uppercase">Chave PIX</label>
            <input value={form.asaas_pix_key} onChange={(e) => setForm({...form, asaas_pix_key: e.target.value})}
              className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm font-mono" />
          </div>
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" checked={form.allow_platform_resale}
              onChange={(e) => setForm({...form, allow_platform_resale: e.target.checked})} className="mt-0.5" />
            <span className="text-white/70">
              Permitir Revenda Direta pela plataforma (Clausula Master). Desativar impede que CAS venda copias do seu produto sem comissao.
            </span>
          </label>
        </section>

        {error && <div className="text-red-400 text-sm bg-red-500/10 p-3 rounded">{error}</div>}
        {ok && <div className="text-green-400 text-sm bg-green-500/10 p-3 rounded">{ok}</div>}

        <button type="submit" className="btn-primary flex items-center gap-2"><Save className="w-4 h-4" /> Salvar</button>
      </form>
    </div>
  );
}
