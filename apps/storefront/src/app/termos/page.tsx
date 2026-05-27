import Link from 'next/link';

export const metadata = {
  title: 'Termos de Uso - Code & Agent Shop',
  description: 'Termos de uso da plataforma Code & Agent Shop. Regras para compradores e vendedores.',
  // FIX-WORKER-9 pass 4: canonical explicito
  alternates: { canonical: '/termos' },
  // FIX-WORKER-9 pass 5: openGraph especifico
  openGraph: {
    title: 'Termos de Uso - Code & Agent Shop',
    description: 'Regras da plataforma: compra, venda, QA, cobranca, take-rate.',
    type: 'website',
    url: '/termos',
  },
  twitter: {
    card: 'summary',
    title: 'Termos de Uso - Code & Agent Shop',
    description: 'Regras para compradores e vendedores.',
  },
};

export default function TermosPage() {
  return (
    // FIX-WORKER-8 pass 2: consistencia com /privacidade (mesma fix): glass panel + prose
    <div className="container mx-auto px-6 py-8 max-w-3xl">
      <Link href="/" className="text-sm text-white/60 hover:text-white not-prose">&larr; Voltar</Link>

      <h1 className="font-display font-bold text-4xl mt-4 mb-2">Termos de Uso</h1>
      <p className="text-white/50 text-sm mb-6">Ultima atualizacao: 26 de maio de 2026</p>

      <div className="glass p-6 md:p-8 prose prose-invert max-w-none space-y-6 text-white/80">
        <section>
          <h2 className="font-display font-bold text-2xl text-white">1. Aceitacao</h2>
          <p>Ao usar a Code & Agent Shop (CAS), voce concorda com estes Termos. Se nao concordar, nao use os servicos.</p>
        </section>

        <section>
          <h2 className="font-display font-bold text-2xl text-white">2. Definicoes</h2>
          <ul className="list-disc pl-6 space-y-1">
            <li><strong>Plataforma:</strong> code-agent-shop.com.br e seus subdominios</li>
            <li><strong>Comprador:</strong> usuario que adquire automacoes/agentes</li>
            <li><strong>Vendedor:</strong> criador que publica produtos no marketplace</li>
            <li><strong>Produto:</strong> automacao, script, workflow, agente IA ou similar</li>
          </ul>
        </section>

        <section>
          <h2 className="font-display font-bold text-2xl text-white">3. Cadastro</h2>
          <p>Para comprar/vender, voce deve fornecer dados verdadeiros e proteger sua senha + 2FA. Voce e responsavel pelas atividades em sua conta.</p>
        </section>

        <section>
          <h2 className="font-display font-bold text-2xl text-white">4. Vendedores</h2>
          <h3 className="font-display font-bold text-xl text-white mt-3">4.1 Comissao</h3>
          <p>A plataforma retem <strong>18% (take rate)</strong> de cada venda organica. Os 82% restantes sao repassados via Asaas Split automatico.</p>

          <h3 className="font-display font-bold text-xl text-white mt-3">4.2 Clausula Master de Revenda Direta</h3>
          <p className="bg-magenta/10 border-l-4 border-magenta p-4 rounded">
            Ao publicar um produto, voce cede a CAS o direito de revender o mesmo ativo separadamente,
            sem comissionamento ao criador original. Esta clausula pode ser desativada nas configuracoes
            da loja (campo allow_platform_resale).
          </p>

          <h3 className="font-display font-bold text-xl text-white mt-3">4.3 Programa Cloud Code Ilimitado (Classe B)</h3>
          <p>Vendedores aprovados no programa Classe B recebem API keys patrocinadas pela plataforma.
            Em contrapartida, devem publicar pelo menos 1 produto aprovado a cada <strong>15 dias</strong>.
            Caso descumpram, as keys serao revogadas automaticamente.</p>

          <h3 className="font-display font-bold text-xl text-white mt-3">4.4 Pipeline QA</h3>
          <p>Todo produto passa por QA automatizado via LLM. Produtos com confidence score abaixo de
            80%, mocks, lixo digital ou plagio sao automaticamente rejeitados.</p>
        </section>

        <section>
          <h2 className="font-display font-bold text-2xl text-white">5. Compradores</h2>
          <p>Voce reconhece que:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Produtos sao licenciados (single use, unlimited, subscription)</li>
            <li>Downloads expiram em 365 dias apos a compra</li>
            <li>Voce pode abrir disputa em ate 30 dias se o produto nao corresponder</li>
            <li>Reembolsos seguem politica do Asaas + 7 dias do CDC</li>
          </ul>
        </section>

        <section>
          <h2 className="font-display font-bold text-2xl text-white">6. Conduta proibida</h2>
          <ul className="list-disc pl-6 space-y-1">
            <li>Plagio, codigo malicioso, malware</li>
            <li>Conteudo ofensivo, ilegal ou que viole direitos autorais</li>
            <li>Bruteforce, scraping em massa ou abuse de API</li>
            <li>Fraude, lavagem de dinheiro, cartoes nao autorizados</li>
          </ul>
          <p>Violacoes resultam em suspensao da conta + comunicacao a autoridades.</p>
        </section>

        <section>
          <h2 className="font-display font-bold text-2xl text-white">7. Limitacao de responsabilidade</h2>
          <p>A CAS atua como intermediadora. Nao garantimos resultados especificos do uso dos produtos.
            Vendedores sao responsaveis pelo suporte e qualidade do que vendem.</p>
        </section>

        <section>
          <h2 className="font-display font-bold text-2xl text-white">8. Alteracoes</h2>
          <p>Podemos alterar estes Termos a qualquer momento. Mudancas relevantes serao notificadas
            por email. Uso continuado apos as alteracoes implica aceitacao.</p>
        </section>

        <section>
          <h2 className="font-display font-bold text-2xl text-white">9. Foro</h2>
          <p>Foro competente: cidade da Inovare AI Ecosystem, Brasil. Lei aplicavel: brasileira (LGPD,
            CDC, Marco Civil da Internet).</p>
        </section>

        <p className="text-sm text-white/60 mt-8 border-t border-white/10 pt-6">
          Contato: <a href="mailto:fabricadeautomacoes0@gmail.com" className="text-magenta">fabricadeautomacoes0@gmail.com</a>
          {' | '}
          <Link href="/privacidade" className="text-magenta">Politica de Privacidade</Link>
        </p>
      </div>
    </div>
  );
}
