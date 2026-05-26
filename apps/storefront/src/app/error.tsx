'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { AlertOctagon, RefreshCw, Home } from 'lucide-react';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('[Global Error]', error);
  }, [error]);

  return (
    <div className="container mx-auto px-6 py-32 max-w-2xl text-center">
      <div className="glass p-12 border-l-4 border-red-500">
        <AlertOctagon className="w-16 h-16 mx-auto mb-4 text-red-400" />
        <h1 className="font-display font-bold text-3xl mb-3">Algo deu errado</h1>
        <p className="text-white/60 mb-2">
          Tivemos um problema ao processar sua requisicao.
        </p>
        {error.digest && (
          <p className="text-xs text-white/40 font-mono mb-8">
            Codigo: {error.digest}
          </p>
        )}
        <div className="flex flex-wrap gap-3 justify-center">
          <button onClick={() => reset()} className="btn-primary inline-flex items-center gap-2">
            <RefreshCw className="w-4 h-4" /> Tentar novamente
          </button>
          <Link href="/" className="btn-ghost inline-flex items-center gap-2">
            <Home className="w-4 h-4" /> Voltar para Home
          </Link>
        </div>
      </div>
    </div>
  );
}
