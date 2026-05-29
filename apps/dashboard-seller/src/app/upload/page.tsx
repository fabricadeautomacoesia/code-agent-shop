'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { sellerFetch, sellerUpload } from '@/lib/seller-api';
import { useSellerAction } from '@/lib/use-seller-action';
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
  const [uploadError, setUploadError] = useState('');

  useEffect(() => {
    sellerFetch<{ categories: any[] }>('/search/categories').then((r) => setCategories(r.categories || []));
  }, []);

  // FIX-WORKER-5 pass 5 (final): useSellerAction substitui submitting+error ad-hoc.
  // Sem reload callback (post-create redireciona para /products).
  // uploadError separado pois uploads sao independentes do submit principal.
  const action = useSellerAction();

  async function handleFile(field: 'cover' | 'pkg', e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    // FIX-WORKER-5: stale closure bug - antes setUploading({...uploading,[field]:true})
    // capturava o estado antigo. Uploads paralelos (cover+pkg) faziam um sobrescrever
    // o flag do outro. Functional setState resolve.
    setUploading((p) => ({ ...p, [field]: true }));
    setUploadError('');
    try {
      const endpoint = field === 'cover' ? '/products/upload/media' : '/products/upload/package';
      const r = await sellerUpload(endpoint, file);
      const targetField = field === 'cover' ? 'cover_image_url' : 'package_url';
      setForm((p) => ({ ...p, [targetField]: r.url }));
    } catch (e: any) {
      setUploadError(`Upload falhou: ${e.message}`);
    } finally {
      setUploading((p) => ({ ...p, [field]: false }));
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // FIX-WORKER-5 pass 255 (defensive number parse):
    //   PRE-FIX: Number(form.price_cents) - input vazio "" -> Number("") = 0
    //   Seller submetia produto sem preencher price_cents -> backend Zod aceitava
    //   0 (campo era required mas com fallback no transform).
    //   Resultado: produto criado com price_cents=0 (gratis sem isFree=true)
    //   -> checkout futuro: Asaas rejeita value=0 ou cobra zero do buyer (loss).
    //   POST-FIX: parseInt + NaN check + setErr early-return amigavel.
    const price = parseInt(form.price_cents, 10);
    const installMin = parseInt(form.estimated_install_min, 10);
    if (!Number.isFinite(price) || price <= 0) {
      action.run('create-draft', async () => {
        throw new Error('Preco deve ser maior que zero (em centavos). Ex: 4990 = R$ 49,90');
      });
      return;
    }
    if (!Number.isFinite(installMin) || installMin <= 0) {
      action.run('create-draft', async () => {
        throw new Error('Tempo estimado de instalacao deve ser maior que zero (em minutos).');
      });
      return;
    }
    action.run('create-draft', async () => {
      const payload = {
        ...form,
        price_cents: price,
        estimated_install_min: installMin,
        tech_stack: form.tech_stack.split(',').map((t) => t.trim()).filter(Boolean),
        api_keys_required: form.api_keys_required.split(',').map((t) => t.trim()).filter(Boolean),
      };
      const r: any = await sellerFetch('/products/me', { method: 'POST', body: JSON.stringify(payload) });
      router.push(`/products?created=${r.product.id}`);
      return 'Draft criado com sucesso, redirecionando...';
    });
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
          {/* FIX-WORKER-5 pass 145 (a11y): 14 labels c/ htmlFor + inputs c/ id (WCAG 1.3.1) */}
          {/* FIX-WORKER-7 pass 338: maxLength alinhado backend Zod (pass 332):
              - title min(5).max(200), subtitle max(300), description min(50).max(30000)
              - install_instructions max(10000) */}
          <div>
            <label htmlFor="up-title" className="text-xs text-white/60 uppercase">Titulo</label>
            <input id="up-title" value={form.title} onChange={(e) => setForm({...form, title: e.target.value})} required minLength={5} maxLength={200}
              className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm focus:border-magenta focus:outline-none" />
          </div>
          <div>
            <label htmlFor="up-subtitle" className="text-xs text-white/60 uppercase">Subtitulo</label>
            <input id="up-subtitle" value={form.subtitle} onChange={(e) => setForm({...form, subtitle: e.target.value})} maxLength={300}
              className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm" />
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="up-category" className="text-xs text-white/60 uppercase">Categoria</label>
              <select id="up-category" value={form.category_id} onChange={(e) => setForm({...form, category_id: e.target.value})} required
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
              <label htmlFor="up-kind" className="text-xs text-white/60 uppercase">Tipo</label>
              <select id="up-kind" value={form.kind} onChange={(e) => setForm({...form, kind: e.target.value})}
                className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm">
                {['automation','ai_agent','n8n_workflow','node_script','python_script','php_script','prompt_pack','template','dataset','other'].map((k) => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label htmlFor="up-shortdesc" className="text-xs text-white/60 uppercase">Descricao curta (max 500)</label>
            <input id="up-shortdesc" value={form.short_description} onChange={(e) => setForm({...form, short_description: e.target.value})} maxLength={500}
              className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm" />
          </div>
          <div>
            <label htmlFor="up-desc" className="text-xs text-white/60 uppercase">Descricao completa (min 50, max 30000 chars)</label>
            <textarea id="up-desc" value={form.description} onChange={(e) => setForm({...form, description: e.target.value})} required minLength={50} maxLength={30000} rows={6}
              className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm font-mono" />
            <div className={`text-[10px] text-right mt-1 ${
              (form.description?.length || 0) > 28500 ? 'text-yellow-400' :
              (form.description?.length || 0) < 50 ? 'text-orange-400' : 'text-white/30'
            }`}>{form.description?.length || 0}/30000{(form.description?.length || 0) < 50 ? ' (min 50)' : ''}</div>
          </div>
        </section>

        <section className="glass p-6 space-y-4">
          <h3 className="font-display font-bold text-lg">Tecnico</h3>
          <div>
            <label htmlFor="up-techstack" className="text-xs text-white/60 uppercase">Tech Stack (CSV: ex Node,PostgreSQL,OpenAI)</label>
            <input id="up-techstack" value={form.tech_stack} onChange={(e) => setForm({...form, tech_stack: e.target.value})}
              className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm font-mono" />
          </div>
          <div>
            <label htmlFor="up-apikeys" className="text-xs text-white/60 uppercase">APIs requeridas (CSV: ex OPENAI_API_KEY)</label>
            <input id="up-apikeys" value={form.api_keys_required} onChange={(e) => setForm({...form, api_keys_required: e.target.value})}
              className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm font-mono" />
          </div>
          <div>
            <label htmlFor="up-install" className="text-xs text-white/60 uppercase">Instrucoes de instalacao (max 10000)</label>
            <textarea id="up-install" value={form.install_instructions} onChange={(e) => setForm({...form, install_instructions: e.target.value})} rows={4} maxLength={10000}
              className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm font-mono" />
          </div>
          <div>
            <label htmlFor="up-installmin" className="text-xs text-white/60 uppercase">Tempo estimado de instalacao (minutos)</label>
            <input id="up-installmin" type="number" inputMode="numeric" value={form.estimated_install_min} onChange={(e) => setForm({...form, estimated_install_min: Number(e.target.value)})}
              className="w-32 px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm" />
          </div>
        </section>

        <section className="glass p-6 space-y-4">
          <h3 className="font-display font-bold text-lg">Preco e licenca</h3>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="up-price" className="text-xs text-white/60 uppercase">Preco em centavos (R$ 29,90 = 2990)</label>
              <input id="up-price" type="number" inputMode="numeric" min={0} value={form.price_cents} onChange={(e) => setForm({...form, price_cents: Number(e.target.value)})}
                className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm font-mono" />
            </div>
            <div>
              <label htmlFor="up-license" className="text-xs text-white/60 uppercase">Tipo de licenca</label>
              <select id="up-license" value={form.license_kind} onChange={(e) => setForm({...form, license_kind: e.target.value})}
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
            <label htmlFor="up-cover" className="text-xs text-white/60 uppercase mb-2 block">Imagem de capa</label>
            <input id="up-cover" type="file" accept="image/*" onChange={(e) => handleFile('cover', e)} className="text-sm" />
            {uploading.cover && <div role="status" aria-live="polite" className="text-xs text-magenta mt-1">Enviando...</div>}
            {form.cover_image_url && (
              <div className="flex items-center gap-2 mt-2 text-sm text-green-400">
                <ImageIcon className="w-4 h-4" aria-hidden="true" /> Cover: <code className="font-mono text-xs">{form.cover_image_url}</code>
              </div>
            )}
          </div>
          <div>
            <label htmlFor="up-pkg" className="text-xs text-white/60 uppercase mb-2 block">Pacote do produto (ZIP/JSON)</label>
            <input id="up-pkg" type="file" accept=".zip,.json,.tar,.gz" onChange={(e) => handleFile('pkg', e)} className="text-sm" />
            {/* FIX-WORKER-5 pass 496 (a11y paridade linha 211 cover upload): role=status + aria-live */}
            {uploading.pkg && <div role="status" aria-live="polite" className="text-xs text-magenta mt-1">Enviando...</div>}
            {form.package_url && (
              <div className="flex items-center gap-2 mt-2 text-sm text-green-400">
                <FileArchive className="w-4 h-4" /> Pacote: <code className="font-mono text-xs">{form.package_url}</code>
              </div>
            )}
          </div>
        </section>

        {/* FIX-WORKER-5 pass 5: banners hook + uploadError separado (paralelo a action)
            FIX-WORKER-5 pass 496 (a11y paridade pass 492 W1 + pass 457 cart):
              PRE-FIX (3 banners regressao a11y):
                1. uploadError: SEM role=alert (SR nao anuncia falha upload critica)
                2. action.error: SEM role=alert (idem)
                3. action.success: SEM role=status + aria-live (SR silent em sucesso)
                4. 3 dismiss 'fechar' buttons: SEM aria-label (SR anuncia "fechar, button"
                   ambiguo - close what? upload error? action error? success?)
                5. 3 dismiss buttons: SEM focus-visible:outline (keyboard nav blind)
                6. 3 banner spans: SEM flex-1 (texto longo pode empurrar close offscreen)
              POST-FIX (paridade qna pass 248 + cart pass 457 + auth pass 492):
                - role=alert em error states + role=status aria-live polite em success
                - aria-label "Fechar mensagem de erro/sucesso" SR contextual
                - focus-visible:outline-2 outline-red/green-400 (keyboard ring)
                - flex-1 no span p/ texto longo nao overflow close button
              Pattern V8 W5: TODOS banners cross-dashboard-seller precisam paridade. */}
        {uploadError && (
          <div role="alert" className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg flex items-center justify-between gap-2">
            <span className="flex-1">{uploadError}</span>
            <button type="button" onClick={() => setUploadError('')}
              aria-label="Fechar mensagem de erro de upload"
              className="text-xs hover:underline focus-visible:outline-2 focus-visible:outline-red-400 rounded">fechar</button>
          </div>
        )}
        {action.error && (
          <div role="alert" className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg flex items-center justify-between gap-2">
            <span className="flex-1">{action.error}</span>
            <button type="button" onClick={action.clear}
              aria-label="Fechar mensagem de erro"
              className="text-xs hover:underline focus-visible:outline-2 focus-visible:outline-red-400 rounded">fechar</button>
          </div>
        )}
        {action.success && (
          <div role="status" aria-live="polite" className="bg-green-500/10 border border-green-500/30 text-green-400 p-4 rounded-lg flex items-center justify-between gap-2">
            <span className="flex-1">{action.success}</span>
            <button type="button" onClick={action.clear}
              aria-label="Fechar mensagem de sucesso"
              className="text-xs hover:underline focus-visible:outline-2 focus-visible:outline-green-400 rounded">fechar</button>
          </div>
        )}

        <button type="submit" disabled={action.busyKey === 'create-draft' || uploading.cover || uploading.pkg}
          className="btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-wait">
          <UploadCloud className="w-4 h-4" /> {action.busyKey === 'create-draft' ? 'Criando draft...' : 'Criar draft'}
        </button>
      </form>
    </div>
  );
}
