'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { sellerFetch, sellerUpload } from '@/lib/seller-api';
import { UploadCloud, ImageIcon, FileArchive, AlertTriangle } from 'lucide-react';

export default function UploadPage() {
  const router = useRouter();
  const [categories, setCategories] = useState<any[]>([]);
  const [form, setForm] = useState({
    title: '', subtitle: '', description: '', short_description: '',
    category_id: '', kind: 'automation',
    price_cents: 0, currency: 'BRL', license_kind: 'single_use',
    tech_stack: '', requirements: '', install_instructions: '',
    api_keys_required: '', estimated_install_min: 5,
    cover_image_url: '', package_url: '',
  });
  const [uploading, setUploading] = useState<{ cover: boolean; pkg: boolean }>({ cover: false, pkg: false });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    sellerFetch<{ categories: any[] }>('/search/categories').then((r) => setCategories(r.categories || []));
  }, []);

  async function handleFile(field: 'cover' | 'pkg', e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    // FIX-WORKER-5: stale closure bug - antes setUploading({...uploading,[field]:true})
    // capturava o estado antigo. Uploads paralelos (cover+pkg) faziam um sobrescrever
    // o flag do outro. Functional setState resolve.
    setUploading((p) => ({ ...p, [field]: true }));
    try {
      const endpoint = field === 'cover' ? '/products/upload/media' : '/products/upload/package';
      const r = await sellerUpload(endpoint, file);
      const targetField = field === 'cover' ? 'cover_image_url' : 'package_url';
      setForm((p) => ({ ...p, [targetField]: r.url }));
    } catch (e: any) {
      setError(`Upload falhou: ${e.message}`);
    } finally {
      setUploading((p) => ({ ...p, [field]: false }));
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true); setError('');
    try {
      const payload = {
        ...form,
        price_cents: Number(form.price_cents),
        estimated_install_min: Number(form.estimated_install_min),
        tech_stack: form.tech_stack.split(',').map((t) => t.trim()).filter(Boolean),
        api_keys_required: form.api_keys_required.split(',').map((t) => t.trim()).filter(Boolean),
      };
      const r: any = await sellerFetch('/products/me', { method: 'POST', body: JSON.stringify(payload) });
      router.push(`/products?created=${r.product.id}`);
    } catch (e: any) {
      setError(e.message);
    } finally { setSubmitting(false); }
  }

  return (
    <div className="max-w-3xl">
      <h1 className="font-display font-bold text-4xl mb-2">Novo produto</h1>
      <p className="text-white/60 mb-8">
        Preencha o formulario. Apos criar o draft, voce envia para o pipeline QA automatizado.
      </p>

      <div className="glass p-4 mb-6 flex items-start gap-3 border-l-4 border-yellow-500">
        <AlertTriangle className="w-5 h-5 text-yellow-400 flex-shrink-0 mt-0.5" />
        <div className="text-sm text-white/80">
          <strong>QA Automatizado:</strong> seu pacote sera analisado por LLM (OpenAI/Gemini/Groq).
          Confidence score &lt;80% = rejeicao automatica. Garanta sintaxe correta, descricao alinhada e nada de mocks/placeholders.
        </div>
      </div>

      <form onSubmit={submit} className="space-y-6">
        <section className="glass p-6 space-y-4">
          <h3 className="font-display font-bold text-lg">Identidade</h3>
          <div>
            <label className="text-xs text-white/60 uppercase">Titulo</label>
            <input value={form.title} onChange={(e) => setForm({...form, title: e.target.value})} required minLength={5}
              className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm focus:border-magenta focus:outline-none" />
          </div>
          <div>
            <label className="text-xs text-white/60 uppercase">Subtitulo</label>
            <input value={form.subtitle} onChange={(e) => setForm({...form, subtitle: e.target.value})}
              className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm" />
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-white/60 uppercase">Categoria</label>
              <select value={form.category_id} onChange={(e) => setForm({...form, category_id: e.target.value})} required
                className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm">
                <option value="">Selecione</option>
                {categories.map((c) => (
                  <optgroup key={c.id} label={c.name}>
                    <option value={c.id}>{c.name}</option>
                    {(c.children || []).map((sc: any) => <option key={sc.id} value={sc.id}>-- {sc.name}</option>)}
                  </optgroup>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-white/60 uppercase">Tipo</label>
              <select value={form.kind} onChange={(e) => setForm({...form, kind: e.target.value})}
                className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm">
                {['automation','ai_agent','n8n_workflow','node_script','python_script','php_script','prompt_pack','template','dataset','other'].map((k) => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs text-white/60 uppercase">Descricao curta (max 500)</label>
            <input value={form.short_description} onChange={(e) => setForm({...form, short_description: e.target.value})} maxLength={500}
              className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm" />
          </div>
          <div>
            <label className="text-xs text-white/60 uppercase">Descricao completa (min 50 chars)</label>
            <textarea value={form.description} onChange={(e) => setForm({...form, description: e.target.value})} required minLength={50} rows={6}
              className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm font-mono" />
          </div>
        </section>

        <section className="glass p-6 space-y-4">
          <h3 className="font-display font-bold text-lg">Tecnico</h3>
          <div>
            <label className="text-xs text-white/60 uppercase">Tech Stack (CSV: ex Node,PostgreSQL,OpenAI)</label>
            <input value={form.tech_stack} onChange={(e) => setForm({...form, tech_stack: e.target.value})}
              className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm font-mono" />
          </div>
          <div>
            <label className="text-xs text-white/60 uppercase">APIs requeridas (CSV: ex OPENAI_API_KEY)</label>
            <input value={form.api_keys_required} onChange={(e) => setForm({...form, api_keys_required: e.target.value})}
              className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm font-mono" />
          </div>
          <div>
            <label className="text-xs text-white/60 uppercase">Instrucoes de instalacao</label>
            <textarea value={form.install_instructions} onChange={(e) => setForm({...form, install_instructions: e.target.value})} rows={4}
              className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm font-mono" />
          </div>
          <div>
            <label className="text-xs text-white/60 uppercase">Tempo estimado de instalacao (minutos)</label>
            <input type="number" value={form.estimated_install_min} onChange={(e) => setForm({...form, estimated_install_min: Number(e.target.value)})}
              className="w-32 px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm" />
          </div>
        </section>

        <section className="glass p-6 space-y-4">
          <h3 className="font-display font-bold text-lg">Preco e licenca</h3>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-white/60 uppercase">Preco em centavos (R$ 29,90 = 2990)</label>
              <input type="number" min={0} value={form.price_cents} onChange={(e) => setForm({...form, price_cents: Number(e.target.value)})}
                className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm font-mono" />
            </div>
            <div>
              <label className="text-xs text-white/60 uppercase">Tipo de licenca</label>
              <select value={form.license_kind} onChange={(e) => setForm({...form, license_kind: e.target.value})}
                className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm">
                <option value="single_use">Uso unico</option>
                <option value="unlimited">Uso ilimitado</option>
                <option value="subscription_monthly">Assinatura mensal</option>
                <option value="subscription_yearly">Assinatura anual</option>
              </select>
            </div>
          </div>
        </section>

        <section className="glass p-6 space-y-4">
          <h3 className="font-display font-bold text-lg">Midia & Pacote</h3>
          <div>
            <label className="text-xs text-white/60 uppercase mb-2 block">Imagem de capa</label>
            <input type="file" accept="image/*" onChange={(e) => handleFile('cover', e)} className="text-sm" />
            {uploading.cover && <div className="text-xs text-magenta mt-1">Enviando...</div>}
            {form.cover_image_url && (
              <div className="flex items-center gap-2 mt-2 text-sm text-green-400">
                <ImageIcon className="w-4 h-4" /> Cover: <code className="font-mono text-xs">{form.cover_image_url}</code>
              </div>
            )}
          </div>
          <div>
            <label className="text-xs text-white/60 uppercase mb-2 block">Pacote do produto (ZIP/JSON)</label>
            <input type="file" accept=".zip,.json,.tar,.gz" onChange={(e) => handleFile('pkg', e)} className="text-sm" />
            {uploading.pkg && <div className="text-xs text-magenta mt-1">Enviando...</div>}
            {form.package_url && (
              <div className="flex items-center gap-2 mt-2 text-sm text-green-400">
                <FileArchive className="w-4 h-4" /> Pacote: <code className="font-mono text-xs">{form.package_url}</code>
              </div>
            )}
          </div>
        </section>

        {error && <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg">{error}</div>}

        <button type="submit" disabled={submitting} className="btn-primary flex items-center gap-2 disabled:opacity-50">
          <UploadCloud className="w-4 h-4" /> {submitting ? 'Criando draft...' : 'Criar draft'}
        </button>
      </form>
    </div>
  );
}
