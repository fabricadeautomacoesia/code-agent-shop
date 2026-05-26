import Link from 'next/link';
import { Sparkles, Shield, Zap, Code2, Users, Award } from 'lucide-react';

export const metadata = {
  title: 'Sobre - Code & Agent Shop',
  description: 'Conheca a Code & Agent Shop, o maior marketplace de automacoes e agentes IA do Brasil.'
};

export default function SobrePage() {
  return (
    <div className="container mx-auto px-6 py-8 max-w-4xl">
      <Link href="/" className="text-sm text-white/60 hover:text-white">&larr; Voltar</Link>

      <h1 className="font-display font-bold text-5xl mb-4 mt-4">
        Sobre a <span className="bg-gradient-vibe bg-clip-text text-transparent">Code & Agent Shop</span>
      </h1>
      <p className="text-xl text-white/70 mb-12 max-w-2xl">
        O marketplace B2B/B2C definitivo para automacoes, scripts, workflows n8n e agentes de
        inteligencia artificial - todos validados por IA antes de chegar a vitrine.
      </p>

      <section className="grid md:grid-cols-3 gap-6 mb-16">
        <div className="glass p-6">
          <Shield className="w-10 h-10 text-magenta mb-3" />
          <h3 className="font-display font-bold text-xl mb-2">QA automatizado</h3>
          <p className="text-sm text-white/60">
            Todo produto passa por pipeline LLM (OpenAI -> Gemini -> Groq) antes de ser aprovado.
            Confidence score minimo 80%.
          </p>
        </div>
        <div className="glass p-6">
          <Zap className="w-10 h-10 text-magenta mb-3" />
          <h3 className="font-display font-bold text-xl mb-2">Asaas Split nativo</h3>
          <p className="text-sm text-white/60">
            Pagamentos via PIX, Cartao e Boleto com split automatico para vendedores.
            Receba 82% de cada venda diretamente.
          </p>
        </div>
        <div className="glass p-6">
          <Award className="w-10 h-10 text-magenta mb-3" />
          <h3 className="font-display font-bold text-xl mb-2">Reputacao Mercado Livre style</h3>
          <p className="text-sm text-white/60">
            6 niveis de reputacao (Iniciante a Lider Platinum) baseados em vendas, rating,
            tempo de resposta e SLA.
          </p>
        </div>
      </section>

      <section className="glass-strong p-10 mb-16">
        <h2 className="font-display font-bold text-3xl mb-6">Nossa missao</h2>
        <p className="text-lg text-white/80 leading-relaxed mb-4">
          Conectar criadores de automacoes e desenvolvedores de agentes IA a empresas que
          precisam dessas solucoes, em um ambiente curado, seguro e altamente performatico.
        </p>
        <p className="text-lg text-white/80 leading-relaxed">
          Acreditamos que automacao bem feita transforma negocios. E que IA aplicada deve ser
          acessivel, validada e justa - tanto para quem compra quanto para quem cria.
        </p>
      </section>

      <section className="grid md:grid-cols-2 gap-8 mb-16">
        <div>
          <h2 className="font-display font-bold text-3xl mb-4">Para compradores</h2>
          <ul className="space-y-3 text-white/80">
            <li className="flex items-start gap-3"><Sparkles className="w-5 h-5 text-magenta flex-shrink-0 mt-0.5" />Automacoes e agentes IA validados por LLM (sem mocks vazios)</li>
            <li className="flex items-start gap-3"><Sparkles className="w-5 h-5 text-magenta flex-shrink-0 mt-0.5" />Reviews verificadas (apenas compradores reais)</li>
            <li className="flex items-start gap-3"><Sparkles className="w-5 h-5 text-magenta flex-shrink-0 mt-0.5" />Q&A direto com o vendedor antes da compra</li>
            <li className="flex items-start gap-3"><Sparkles className="w-5 h-5 text-magenta flex-shrink-0 mt-0.5" />Protecao ao comprador via disputas mediadas</li>
            <li className="flex items-start gap-3"><Sparkles className="w-5 h-5 text-magenta flex-shrink-0 mt-0.5" />Download imediato + suporte 365 dias</li>
          </ul>
        </div>
        <div>
          <h2 className="font-display font-bold text-3xl mb-4">Para vendedores</h2>
          <ul className="space-y-3 text-white/80">
            <li className="flex items-start gap-3"><Sparkles className="w-5 h-5 text-magenta flex-shrink-0 mt-0.5" />82% liquido por venda (split nativo Asaas)</li>
            <li className="flex items-start gap-3"><Sparkles className="w-5 h-5 text-magenta flex-shrink-0 mt-0.5" />Audiencia B2B/B2C qualificada</li>
            <li className="flex items-start gap-3"><Sparkles className="w-5 h-5 text-magenta flex-shrink-0 mt-0.5" />Programa Cloud Code Ilimitado (Classe B) com API keys patrocinadas</li>
            <li className="flex items-start gap-3"><Sparkles className="w-5 h-5 text-magenta flex-shrink-0 mt-0.5" />Reputacao Mercado Livre style (6 tiers)</li>
            <li className="flex items-start gap-3"><Sparkles className="w-5 h-5 text-magenta flex-shrink-0 mt-0.5" />Pagamento sem 30 dias de espera</li>
          </ul>
        </div>
      </section>

      <section className="text-center glass p-10 mb-16">
        <Code2 className="w-16 h-16 mx-auto mb-4 text-magenta" />
        <h2 className="font-display font-bold text-3xl mb-3">Comece agora</h2>
        <p className="text-white/70 mb-6">
          Explore o catalogo ou comece a vender suas automacoes hoje mesmo.
        </p>
        <div className="flex flex-wrap gap-3 justify-center">
          <Link href="/products" className="btn-primary">Ver produtos</Link>
          <Link href="/register?role=seller" className="btn-ghost">Quero vender</Link>
        </div>
      </section>

      <div className="text-center text-white/50">
        <p>Powered by <strong className="text-magenta">Inovare AI Ecosystem</strong> - Blueprint V8</p>
      </div>
    </div>
  );
}
