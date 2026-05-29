import Link from 'next/link';
import { Cloud, Zap, Clock, Award, AlertTriangle, CheckCircle } from 'lucide-react';

// FIX-WORKER-9 pass 585 (enrich metadata paridade /sellers + /promocoes consolidacao):
//   PRE-FIX (pass 5): openGraph + twitter basics, MAS faltava:
//   - openGraph: siteName + locale + images
//   - twitter: images
//   - keywords (SEO discovery via search engines)
//   - robots: index:true follow:true explicit (era undefined - inheritance root)
//   Cadeia W9 metadata enrichment cross-storefront completa:
//     pass 519 /sellers (siteName + locale + images + keywords + robots index)
//     pass 538 /conta/downloads/[token] openGraph + twitter card enriched
//     pass 557 /conta/seguranca + /conta/perfil + /conta/pontos twitter card
//     pass 585 (este) /cloud-code-ilimitado enrich paridade
export const metadata = {
  title: 'Cloud Code Ilimitado - Programa Classe B - Code & Agent Shop',
  description: 'Programa exclusivo para vendedores Classe B com API keys patrocinadas pela plataforma.',
  // FIX-WORKER-9 pass 4: canonical explicito
  alternates: { canonical: '/cloud-code-ilimitado' },
  // FIX-WORKER-9 pass 5 + 585: openGraph + twitter especifico ENRICHED
  openGraph: {
    title: 'Cloud Code Ilimitado - API Keys Patrocinadas para Sellers',
    description: 'Programa Classe B: OpenAI, Anthropic, Gemini com chaves patrocinadas pela plataforma. Sem limite de uso.',
    type: 'website',
    url: 'https://cas.inovareinteligenciaartificial.com/cloud-code-ilimitado',
    siteName: 'Code & Agent Shop',
    locale: 'pt_BR',
    images: ['/opengraph-image'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Cloud Code Ilimitado - Code & Agent Shop',
    description: 'API keys patrocinadas para vendedores aprovados Classe B.',
    images: ['/opengraph-image'],
  },
  keywords: ['cloud code ilimitado', 'classe b', 'api keys patrocinadas', 'openai gemini anthropic', 'sellers programa'],
  robots: { index: true, follow: true },
};

export default function CloudCodeIlimitadoPage() {
  return (
    <div className="container mx-auto px-6 py-8 max-w-4xl">
      <Link href="/" className="text-sm text-white/60 hover:text-white">&larr; Voltar</Link>

      <div className="text-center mb-16 mt-4">
        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full glass mb-6 text-sm">
          <Cloud className="w-4 h-4 text-magenta" />
          <span className="text-white/80">Programa Exclusivo</span>
        </div>
        <h1 className="font-display font-bold text-5xl md:text-6xl mb-4">
          <span className="bg-gradient-vibe bg-clip-text text-transparent">Cloud Code Ilimitado</span>
        </h1>
        <p className="text-xl text-white/70 max-w-2xl mx-auto">
          API keys de LLM (OpenAI, Gemini, Anthropic) <strong className="text-white">patrocinadas pela plataforma</strong>
          {' '}para vendedores aprovados no programa Classe B.
        </p>
      </div>

      <section className="grid md:grid-cols-3 gap-6 mb-16">
        <div className="glass p-6">
          <Zap className="w-10 h-10 text-magenta mb-3" />
          <h3 className="font-display font-bold text-xl mb-2">Sem custo de API</h3>
          <p className="text-sm text-white/60">
            Nao gaste mais com OpenAI/Anthropic. Construa seus agentes IA com as keys do programa.
            Cota mensal por seller configuravel.
          </p>
        </div>
        <div className="glass p-6">
          <Award className="w-10 h-10 text-magenta mb-3" />
          <h3 className="font-display font-bold text-xl mb-2">82% por venda</h3>
          <p className="text-sm text-white/60">
            Mesma comissao da Classe A. O programa nao cobra adicional - a plataforma se paga
            com o aumento de volume de vendas.
          </p>
        </div>
        <div className="glass p-6">
          <Clock className="w-10 h-10 text-magenta mb-3" />
          <h3 className="font-display font-bold text-xl mb-2">SLA de 15 dias</h3>
          <p className="text-sm text-white/60">
            Voce deve publicar pelo menos 1 produto aprovado a cada 15 dias. Cronometro em tempo real
            no painel do vendedor.
          </p>
        </div>
      </section>

      <section className="glass-strong p-10 mb-16">
        <h2 className="font-display font-bold text-3xl mb-6">Como funciona</h2>
        <ol className="space-y-4 text-white/80">
          <li className="flex gap-4">
            <span className="font-display font-bold text-2xl text-magenta">1.</span>
            <div>
              <strong>Cadastre-se como vendedor</strong>
              <p className="text-sm text-white/60 mt-1">
                Crie sua conta com role=seller, complete o KYC e publique pelo menos 1 produto
                aprovado para entrar na fila de avaliacao.
              </p>
            </div>
          </li>
          <li className="flex gap-4">
            <span className="font-display font-bold text-2xl text-magenta">2.</span>
            <div>
              <strong>Avaliacao pelo admin</strong>
              <p className="text-sm text-white/60 mt-1">
                Avaliamos historico, qualidade do produto, reputacao e potencial. Aprovados sao
                promovidos para Classe B com 1 clique pelo admin.
              </p>
            </div>
          </li>
          <li className="flex gap-4">
            <span className="font-display font-bold text-2xl text-magenta">3.</span>
            <div>
              <strong>Acesso ao Vault</strong>
              <p className="text-sm text-white/60 mt-1">
                Suas requisicoes para OpenAI/Gemini sao roteadas automaticamente via Vault da
                plataforma. Cota mensal pre-configurada (negociavel).
              </p>
            </div>
          </li>
          <li className="flex gap-4">
            <span className="font-display font-bold text-2xl text-magenta">4.</span>
            <div>
              <strong>Cronometro SLA</strong>
              <p className="text-sm text-white/60 mt-1">
                Painel mostra dias/horas/min restantes para o proximo upload obrigatorio.
                Avisos automaticos em 7d, 3d e 1d antes.
              </p>
            </div>
          </li>
        </ol>
      </section>

      <section className="glass p-8 mb-16 border-l-4 border-yellow-500">
        <div className="flex items-start gap-4">
          <AlertTriangle className="w-8 h-8 text-yellow-400 flex-shrink-0 mt-1" />
          <div>
            <h3 className="font-display font-bold text-2xl mb-3">Regras importantes</h3>
            <ul className="space-y-2 text-white/80">
              <li className="flex items-start gap-2"><CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0 mt-1" />Voce deve publicar 1 produto aprovado a cada 15 dias</li>
              <li className="flex items-start gap-2"><CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0 mt-1" />Cota mensal de API: combinada no aceite (default US$ 100)</li>
              <li className="flex items-start gap-2"><AlertTriangle className="w-4 h-4 text-yellow-400 flex-shrink-0 mt-1" />Se vencer o SLA: keys revogadas automaticamente (status=sla_revoked)</li>
              <li className="flex items-start gap-2"><AlertTriangle className="w-4 h-4 text-yellow-400 flex-shrink-0 mt-1" />Reativacao pos-revogacao apenas via contato com admin</li>
              <li className="flex items-start gap-2"><AlertTriangle className="w-4 h-4 text-yellow-400 flex-shrink-0 mt-1" />Uso abusivo (spike detection) bloqueia tenant por 10min</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="text-center glass p-10">
        <Cloud className="w-16 h-16 mx-auto mb-4 text-magenta" />
        <h2 className="font-display font-bold text-3xl mb-3">Quer participar?</h2>
        <p className="text-white/70 mb-6">
          Cadastre-se como vendedor, publique seu primeiro produto e entre na fila.
        </p>
        <div className="flex flex-wrap gap-3 justify-center">
          <Link href="/register?role=seller" className="btn-primary">Comecar agora</Link>
          <Link href="/sobre" className="btn-ghost">Saiba mais sobre a CAS</Link>
        </div>
      </section>
    </div>
  );
}
