import Link from 'next/link';

export function Footer() {
  return (
    <footer className="relative z-10 border-t border-white/5 mt-32">
      <div className="container mx-auto px-6 py-16 grid grid-cols-2 md:grid-cols-4 gap-8">
        <div className="col-span-2 md:col-span-1">
          <div className="font-display font-bold text-xl mb-3">Code & Agent Shop</div>
          <p className="text-sm text-white/60">
            O maior marketplace B2B/B2C de automacoes, scripts, workflows n8n e agentes de IA.
          </p>
        </div>
        <div>
          <div className="text-white/80 font-semibold mb-3 text-sm">Catalogo</div>
          <ul className="space-y-2 text-sm text-white/60">
            <li><Link href="/products?kind=ai_agent">Agentes IA</Link></li>
            <li><Link href="/products?kind=n8n_workflow">Workflows n8n</Link></li>
            <li><Link href="/products?kind=automation">Automacoes</Link></li>
            <li><Link href="/products?kind=script">Scripts</Link></li>
          </ul>
        </div>
        <div>
          <div className="text-white/80 font-semibold mb-3 text-sm">Vender</div>
          <ul className="space-y-2 text-sm text-white/60">
            <li><Link href="/register?role=seller">Cadastrar-se como vendedor</Link></li>
            <li><Link href="/seller/dashboard">Painel do vendedor</Link></li>
            <li><Link href="/cloud-code-ilimitado">Cloud Code Ilimitado</Link></li>
          </ul>
        </div>
        <div>
          <div className="text-white/80 font-semibold mb-3 text-sm">Legal</div>
          <ul className="space-y-2 text-sm text-white/60">
            <li><Link href="/termos">Termos de Uso</Link></li>
            <li><Link href="/privacidade">Privacidade</Link></li>
            <li><Link href="/status">Status do Sistema</Link></li>
          </ul>
        </div>
      </div>
      <div className="border-t border-white/5 py-6 text-center text-xs text-white/40">
        (c) {new Date().getFullYear()} Code & Agent Shop - Inovare AI Ecosystem. Todos os direitos reservados.
      </div>
    </footer>
  );
}
