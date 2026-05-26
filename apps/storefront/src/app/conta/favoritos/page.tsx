'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Heart } from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth } from '@/lib/store';
import { ProductCard } from '@/components/product-card';

export default function FavoritosPage() {
  const router = useRouter();
  const { token } = useAuth();
  const [products, setProducts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) { router.push('/login'); return; }
    Api.api<{ products: any[] }>('/products/wishlist', { auth: token, cache: 'no-store' })
      .then((r) => setProducts(r.products))
      .finally(() => setLoading(false));
  }, [token]);

  return (
    <div className="container mx-auto px-6 py-8">
      <Link href="/conta" className="text-sm text-white/60 hover:text-white">&larr; Voltar para conta</Link>
      <h1 className="font-display font-bold text-4xl mt-4 mb-2">Meus favoritos</h1>
      <p className="text-white/60 mb-8">{products.length} produto(s) salvo(s)</p>

      {loading ? (
        <div className="text-center py-12 text-white/60">Carregando...</div>
      ) : products.length === 0 ? (
        <div className="glass p-12 text-center">
          <Heart className="w-16 h-16 mx-auto mb-4 text-white/30" />
          <p className="text-xl mb-4">Voce ainda nao favoritou nenhum produto</p>
          <Link href="/products" className="btn-primary inline-block">Explorar catalogo</Link>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {products.map((p) => <ProductCard key={p.id} product={p} />)}
        </div>
      )}
    </div>
  );
}
