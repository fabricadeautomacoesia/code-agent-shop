import Link from 'next/link';
import { AlertTriangle, ArrowLeft, Search } from 'lucide-react';

export default function NotFound() {
  return (
    <div className="container mx-auto px-6 py-32 max-w-2xl text-center">
      <div className="glass p-12">
        <div className="text-9xl font-display font-bold bg-gradient-vibe bg-clip-text text-transparent mb-4">
          404
        </div>
        <AlertTriangle className="w-16 h-16 mx-auto mb-4 text-magenta opacity-50" />
        <h1 className="font-display font-bold text-3xl mb-3">Pagina nao encontrada</h1>
        <p className="text-white/60 mb-8">
          A pagina que voce procura nao existe ou foi movida.
        </p>
        <div className="flex flex-wrap gap-3 justify-center">
          <Link href="/" className="btn-primary inline-flex items-center gap-2">
            <ArrowLeft className="w-4 h-4" /> Voltar para a Home
          </Link>
          <Link href="/products" className="btn-ghost inline-flex items-center gap-2">
            <Search className="w-4 h-4" /> Explorar catalogo
          </Link>
        </div>
      </div>
    </div>
  );
}
