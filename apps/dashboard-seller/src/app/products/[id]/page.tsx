'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Save, Send, Trash2 } from 'lucide-react';
import { sellerFetch, sellerUpload } from '@/lib/seller-api';

const KINDS = ['automation','ai_agent','n8n_workflow','node_script','python_script','php_script','prompt_pack','template','dataset','other'];

export default function EditProductPage() {
  const router = useRouter();
  const { id } = useParams();
  const [products, setProducts] = useState<any[]>([]);
  const [form, setForm] = useState<any>(null);
  const [uploading, setUploading] = useState({ cover: false, pkg: false });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    sellerFetch<{ products: any[] }>('/products/me')
      .then((r) => {
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
      })
      .catch((e) => setErr(e.message));
  }, [id]);

  async function handleFile(field: 'cover' | 'pkg', e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return;
    setUploading({ ...uploading, [field]: true });
    try {
      const endpoint = field === 'cover' ? '/products/upload/media' : '/products/upload/package';
      const r = await sellerUpload(endpoint, file);
      setForm({ ...form, [field === 'cover' ? 'cover_image_url' : 'package_url']: r.url });
    } catch (e: any) { setErr('Upload falhou: ' + e.message); }
    finally { setUploading({ ...uploading, [field]: false }); }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setErr(''); setMsg('');
    try {
      const payload = {
        ...form,
        price_cents: Number(form.price_cents),
        estimated_install_min: Number(form.estimated_install_min),
        tech_stack: form.tech_stack.split(',').map((t: string) => t.trim()).filter(Boolean),
        api_keys_required: form.api_keys_required.split(',').map((t: string) => t.trim()).filter(Boolean),
      };
      await sellerFetch(`/products/me/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      setMsg('Salvo!');
    } catch (e: any) { setErr(e.message); }
    finally { setSaving(false); }
  }

  async function submit() {
    if (!confirm('Enviar para QA automatizado? Voce nao podera editar ate o resultado.')) return;
    try {
      await sellerFetch(`/products/me/${id}/submit`, { method: 'POST' });
      router.push('/products');
    } catch (e: any) { setErr(e.message); }
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
          <button onClick={submit} className="btn-primary flex items-center gap-2">
            <Send className="w-4 h-4" /> Enviar para QA
          </button>
        )}
      </div>

      {!isEditable && (
        <div className="bg-yellow-500/10 border border-yellow-500/30 text-yellow-300 p-3 rounded mb-4 text-sm">
          Produto em status &quot;{product?.status}&quot; nao pode ser editado.
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

        {err && <div className="text-red-400 text-sm bg-red-500/10 p-3 rounded">{err}</div>}
        {msg && <div className="text-green-400 text-sm bg-green-500/10 p-3 rounded">{msg}</div>}

        {isEditable && (
          <button type="submit" disabled={saving} className="btn-primary flex items-center gap-2 disabled:opacity-50">
            <Save className="w-4 h-4" /> {saving ? 'Salvando...' : 'Salvar alteracoes'}
          </button>
        )}
      </form>
    </div>
  );
}
