'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Save, Send, Trash2 } from 'lucide-react';
import { sellerFetch, sellerUpload } from '@/lib/seller-api';
import { useSellerAction } from '@/lib/use-seller-action';

const KINDS = ['automation','ai_agent','n8n_workflow','node_script','python_script','php_script','prompt_pack','template','dataset','other'];

export default function EditProductPage() {
  const router = useRouter();
  const { id } = useParams();
  const [products, setProducts] = useState<any[]>([]);
  const [form, setForm] = useState<any>(null);
  const [uploading, setUploading] = useState({ cover: false, pkg: false });
  const [loadError, setLoadError] = useState('');

  async function load() {
    try {
      const r = await sellerFetch<{ products: any[] }>('/products/me');
      setProducts(r.products);
      const p = r.products.find((x: any) => x.id === id);
      if (p) setForm({
        title: p.title || '', subtitle: p.subtitle || '',
        description: p.description || '', short_description: p.short_description || '',
        price_cents: p.price_cents || 0, kind: p.kind || 'automation',
        tech_stack: (p.tech_stack || []).join(','),
        requirements: p.requirements || '', install_instructions: p.install_instructions || '',
        api_keys_required: (p.api_keys_required || []).join(','),
        estimated_install_min: p.estimated_install_min || 5,
        cover_image_url: p.cover_image_url || '', package_url: p.package_url || '',
      });
      setLoadError('');
    } catch (e: any) { setLoadError(e.message); }
  }

  useEffect(() => { load(); }, [id]);

  // FIX-WORKER-5 pass 4: useSellerAction substitui saving + err + msg states ad-hoc
  const action = useSellerAction(load);

  async function handleFile(field: 'cover' | 'pkg', e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return;
    setUploading({ ...uploading, [field]: true });
    try {
      const endpoint = field === 'cover' ? '/products/upload/media' : '/products/upload/package';
      const r = await sellerUpload(endpoint, file);
      setForm({ ...form, [field === 'cover' ? 'cover_image_url' : 'package_url']: r.url });
    } catch (e: any) { setLoadError('Upload falhou: ' + e.message); }
    finally { setUploading({ ...uploading, [field]: false }); }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    action.run('save', async () => {
      const payload = {
        ...form,
        price_cents: Number(form.price_cents),
        estimated_install_min: Number(form.estimated_install_min),
        tech_stack: form.tech_stack.split(',').map((t: string) => t.trim()).filter(Boolean),
        api_keys_required: form.api_keys_required.split(',').map((t: string) => t.trim()).filter(Boolean),
      };
      await sellerFetch(`/products/me/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      return 'Produto atualizado com sucesso';
    });
  }

  async function submit() {
    const { confirmDialog } = await import('@/components/prompt-dialog');
    if (!await confirmDialog('Enviar para QA automatizado?', {
      body: 'Voce nao podera editar ate o resultado.',
      variant: 'danger', confirmLabel: 'Enviar para QA',
    })) return;
    action.run('submit', async () => {
      await sellerFetch(`/products/me/${id}/submit`, { method: 'POST' });
      router.push('/products');
      return 'Enviado para QA pipeline';
    });
  }

  if (!form) return <div className="text-white/60">Carregando...</div>;
  const product = products.find((p: any) => p.id === id);
  const isEditable = product && ['draft','rejected'].includes(product.status);

  return (
    <div className="max-w-3xl">
      <Link href="/products" className="text-sm text-white/60 hover:text-white">&larr; Meus produtos</Link>

      <div className="flex items-end justify-between mb-8 mt-4">
        <div>
          <h1 className="font-display font-bold text-3xl">Editar produto</h1>
          <p className="text-white/60 text-sm">Status: <span className="px-2 py-0.5 rounded bg-white/10 text-xs">{product?.status}</span></p>
        </div>
        {isEditable && (
          <button onClick={submit} disabled={action.busyKey === 'submit' || action.busyKey === 'save'}
            className="btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-wait">
            <Send className="w-4 h-4" /> {action.busyKey === 'submit' ? 'Enviando QA...' : 'Enviar para QA'}
          </button>
        )}
      </div>

      {!isEditable && (
        <div className="bg-yellow-500/10 border border-yellow-500/30 text-yellow-300 p-3 rounded mb-4 text-sm">
          Produto em status &quot;{product?.status}&quot; nao pode ser editado.
        </div>
      )}

      {/* FIX-WORKER-5 pass 4: banners via useSellerAction (substituem err+msg ad-hoc) */}
      {loadError && <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4">Erro: {loadError}</div>}
      {action.error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4 flex items-center justify-between">
          <span>{action.error}</span>
          <button onClick={action.clear} className="text-xs hover:underline">fechar</button>
        </div>
      )}
      {action.success && (
        <div className="bg-green-500/10 border border-green-500/30 text-green-400 p-4 rounded-lg mb-4 flex items-center justify-between">
          <span>{action.success}</span>
          <button onClick={action.clear} className="text-xs hover:underline">fechar</button>
        </div>
      )}

      <form onSubmit={save} className="space-y-4">
        <div className="glass p-5 space-y-3">
          <div>
            <label className="text-xs text-white/60 uppercase">Titulo</label>
            <input value={form.title} onChange={(e) => setForm({...form, title: e.target.value})} disabled={!isEditable}
              className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm disabled:opacity-50" />
          </div>
          <div>
            <label className="text-xs text-white/60 uppercase">Subtitulo</label>
            <input value={form.subtitle} onChange={(e) => setForm({...form, subtitle: e.target.value})} disabled={!isEditable}
              className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm disabled:opacity-50" />
          </div>
          <div>
            <label className="text-xs text-white/60 uppercase">Tipo</label>
            <select value={form.kind} onChange={(e) => setForm({...form, kind: e.target.value})} disabled={!isEditable}
              className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm disabled:opacity-50">
              {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-white/60 uppercase">Descricao completa</label>
            <textarea value={form.description} onChange={(e) => setForm({...form, description: e.target.value})} disabled={!isEditable} rows={6}
              className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm disabled:opacity-50 font-mono" />
          </div>
          <div>
            <label className="text-xs text-white/60 uppercase">Preco em centavos</label>
            <input type="number" value={form.price_cents} onChange={(e) => setForm({...form, price_cents: e.target.value})} disabled={!isEditable}
              className="w-32 px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm disabled:opacity-50 font-mono" />
          </div>
          <div>
            <label className="text-xs text-white/60 uppercase">Tech stack (CSV)</label>
            <input value={form.tech_stack} onChange={(e) => setForm({...form, tech_stack: e.target.value})} disabled={!isEditable}
              className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-sm disabled:opacity-50 font-mono" />
          </div>
        </div>

        <div className="glass p-5 space-y-3">
          <h3 className="font-display font-bold text-lg">Midia</h3>
          <div>
            <label className="text-xs text-white/60 uppercase mb-1 block">Imagem capa</label>
            <input type="file" accept="image/*" onChange={(e) => handleFile('cover', e)} disabled={!isEditable} className="text-sm" />
            {form.cover_image_url && <div className="text-xs text-green-400 mt-1">Atual: {form.cover_image_url}</div>}
          </div>
          <div>
            <label className="text-xs text-white/60 uppercase mb-1 block">Pacote</label>
            <input type="file" accept=".zip,.json,.tar,.gz" onChange={(e) => handleFile('pkg', e)} disabled={!isEditable} className="text-sm" />
            {form.package_url && <div className="text-xs text-green-400 mt-1">Atual: {form.package_url}</div>}
          </div>
        </div>

        {/* FIX-WORKER-5 pass 4: banners err+msg removidos (movidos para topo via action hook) */}
        {isEditable && (
          <button type="submit" disabled={action.busyKey === 'save' || action.busyKey === 'submit'}
            className="btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-wait">
            <Save className="w-4 h-4" /> {action.busyKey === 'save' ? 'Salvando...' : 'Salvar alteracoes'}
          </button>
        )}
      </form>
    </div>
  );
}
