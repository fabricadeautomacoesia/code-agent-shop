'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Download, Copy, ExternalLink, ShieldCheck } from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth } from '@/lib/store';

export default function DownloadPage() {
  const router = useRouter();
  const params = useParams();
  const { token } = useAuth();
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!token) { router.push('/login'); return; }
    Api.api<any>(`/orders/download/${params.token}`, { auth: token, cache: 'no-store' })
      .then((d) => setData(d))
      .catch((e) => setErr(e.data?.message || e.message));
  }, [token, params.token]);

  if (err) return (
    <div className="container mx-auto px-6 py-16 max-w-lg text-center">
      <h1 className="font-display font-bold text-2xl mb-3 text-red-400">Download indisponivel</h1>
      <p className="text-white/60 mb-6">{err}</p>
      <Link href="/conta" className="btn-primary">Voltar</Link>
    </div>
  );
  if (!data) return <div className="container mx-auto px-6 py-16 text-center text-white/60">Carregando...</div>;

  return (
    <div className="container mx-auto px-6 py-8 max-w-2xl">
      <Link href="/conta" className="text-sm text-white/60 hover:text-white">&larr; Voltar</Link>

      <div className="glass p-8 mt-4">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-14 h-14 rounded-xl bg-gradient-vibe flex items-center justify-center">
            <ShieldCheck className="w-7 h-7" />
          </div>
          <div>
            <h1 className="font-display font-bold text-2xl">{data.title}</h1>
            <p className="text-sm text-white/60">Download liberado ate {new Date(data.expires_at).toLocaleDateString('pt-BR')}</p>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-xs text-white/60 uppercase mb-1 block">License key (guarde com seguranca)</label>
            <div className="flex gap-2">
              <code className="flex-1 bg-black/30 px-4 py-3 rounded font-mono text-sm">{data.license_key}</code>
              <button onClick={() => navigator.clipboard.writeText(data.license_key)} className="px-3 hover:bg-white/5 rounded">
                <Copy className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div>
            <label className="text-xs text-white/60 uppercase mb-1 block">Downloads usados</label>
            <div className="text-sm">{data.download_count} vez(es)</div>
          </div>

          <a href={data.download_url} target="_blank" rel="noopener noreferrer"
            className="btn-primary w-full inline-flex items-center justify-center gap-2 text-base">
            <Download className="w-5 h-5" /> Fazer download do pacote
            <ExternalLink className="w-4 h-4" />
          </a>

          <p className="text-xs text-white/50 text-center">
            Voce pode fazer download multiplas vezes ate a data de expiracao.
            Em caso de problemas, abra uma <Link href="/conta/pedidos" className="text-magenta hover:underline">disputa</Link>.
          </p>
        </div>
      </div>
    </div>
  );
}
