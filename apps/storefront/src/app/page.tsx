import Link from 'next/link';
import { ArrowRight, Bot, Workflow, Code2, Sparkles, Shield, Zap, TrendingUp } from 'lucide-react';
import { Api } from '@/lib/api';
import { ProductCard } from '@/components/product-card';

export const revalidate = 120;

export default async function HomePage() {
  let featured: any[] = [];
  let trending: any[] = [];
  try {
    const search = await Api.search({ sort: 'sales', limit: 8 });
    featured = search.results;
    const t = await Api.trending();
    trending = t.trending.slice(0, 6);
  } catch { /* SSR resiliente */ }

  return (
    <div className="space-y-32 pb-32">
      {/* HERO */}
      <section className="container mx-auto px-6 pt-12">
        <div className="grid lg:grid-cols-2 gap-12 items-center">
          <div>
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full glass mb-6 text-sm">
              <Sparkles className="w-4 h-4 text-magenta animate-pulse" />
              <span className="text-white/80">Powered by Inovare AI Ecosystem</span>
            </div>
            <h1 className="font-display font-bold text-5xl lg:text-7xl leading-[1.05] mb-6">
              O <span className="bg-gradient-vibe bg-clip-text text-transparent">marketplace</span> de
              <br />automacoes e agentes IA
            </h1>
            <p className="text-lg text-white/70 mb-8 max-w-xl">
              Compre, venda e licencie automacoes prontas para producao. Workflows n8n, scripts Node/Python/PHP,
              agentes LLM, prompt packs — tudo curado e validado por IA.
            </p>
            <div className="flex flex-wrap gap-4">
              <Link href="/products" className="btn-primary inline-flex items-center gap-2">
                Explorar catalogo <ArrowRight className="w-4 h-4" />
              </Link>
              <Link href="/register?role=seller" className="btn-ghost inline-flex items-center gap-2">
                Vender meus codigos
              </Link>
            </div>
            <div className="grid grid-cols-3 gap-6 mt-12 text-sm">
              <div><div className="text-2xl font-display font-bold text-magenta-glow">QA Auto</div><div className="text-white/50">Validacao LLM</div></div>
              <div><div className="text-2xl font-display font-bold text-magenta-glow">Asaas</div><div className="text-white/50">Split nativo</div></div>
              <div><div className="text-2xl font-display font-bold text-magenta-glow">2FA</div><div className="text-white/50">Seguranca</div></div>
            </div>
          </div>
          <div className="relative">
            <div className="glass p-8 relative animate-float">
              <div className="absolute -top-3 -right-3 px-3 py-1 rounded-full bg-gradient-vibe text-xs font-bold">VITRINE</div>
              <pre className="font-mono text-xs text-white/80 leading-relaxed overflow-hidden">
{`{
  "tipo": "agente_ia",
  "nome": "Atendente B2B",
  "stack": ["openai", "langchain", "rag"],
  "preco_brl": 297.00,
  "vendas": 1247,
  "qa_confidence": 0.94,
  "selo": "OFICIAL CAS"
}`}
              </pre>
              <div className="absolute -bottom-6 -left-6 glass-strong p-4 rounded-xl shadow-2xl">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-gradient-vibe flex items-center justify-center">
                    <Shield className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="text-xs text-white/60">QA Automatizado</div>
                    <div className="text-sm font-semibold">Confidence 94%</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* CATEGORIAS DESTAQUE */}
      <section className="container mx-auto px-6">
        <h2 className="font-display font-bold text-3xl mb-8 reveal-up">Por onde comecar</h2>
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
          {[
            { kind: 'ai_agent',      icon: Bot,      title: 'Agentes IA', desc: 'LLMs autonomos, RAG, chatbots' },
            { kind: 'n8n_workflow',  icon: Workflow, title: 'Workflows n8n', desc: 'Templates prontos para importar' },
            { kind: 'automation',    icon: Zap,      title: 'Automacoes', desc: 'WhatsApp, CRM, e-commerce' },
            { kind: 'node_script',   icon: Code2,    title: 'Scripts', desc: 'Node, Python, PHP prontos' },
          ].map((c) => (
            <Link key={c.kind} href={`/products?kind=${c.kind}`} className="glass p-6 hover:scale-105 transition-transform reveal-up group">
              <c.icon className="w-10 h-10 text-magenta mb-4 group-hover:scale-110 transition-transform" />
              <h3 className="font-display font-bold text-lg mb-2">{c.title}</h3>
              <p className="text-sm text-white/60">{c.desc}</p>
            </Link>
          ))}
        </div>
      </section>

      {/* PRODUTOS EM DESTAQUE */}
      {featured.length > 0 && (
        <section className="container mx-auto px-6">
          <div className="flex items-end justify-between mb-8">
            <h2 className="font-display font-bold text-3xl reveal-up">Mais vendidos</h2>
            <Link href="/products?sort=sales" className="text-sm text-magenta hover:underline">Ver todos</Link>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {featured.map((p) => <ProductCard key={p.id} product={p} />)}
          </div>
        </section>
      )}

      {/* TRENDING SEARCHES */}
      {trending.length > 0 && (
        <section className="container mx-auto px-6">
          <h2 className="font-display font-bold text-3xl mb-6 reveal-up flex items-center gap-3">
            <TrendingUp className="w-7 h-7 text-magenta" /> Mais buscados na semana
          </h2>
          <div className="flex flex-wrap gap-3">
            {trending.map((t) => (
              <Link key={t.query_normalized} href={`/products?q=${encodeURIComponent(t.query_normalized)}`}
                className="glass px-4 py-2 text-sm hover:border-magenta transition-colors">
                {t.query_normalized} <span className="text-white/40 ml-2">{t.count}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* CTA SELLER */}
      <section className="container mx-auto px-6">
        <div className="glass-strong p-12 lg:p-16 relative overflow-hidden reveal-up">
          <div className="absolute inset-0 bg-gradient-vibe opacity-10" />
          <div className="relative z-10 max-w-3xl">
            <h2 className="font-display font-bold text-4xl mb-4">
              Voce constroi, nos vendemos.
            </h2>
            <p className="text-lg text-white/70 mb-8">
              Cadastre-se como vendedor e tenha sua loja propria. Receba 82% de cada venda via Asaas Split.
              Programa <strong className="text-magenta">Cloud Code Ilimitado</strong> da chaves de API custeadas pela plataforma.
            </p>
            <Link href="/register?role=seller" className="btn-primary inline-flex items-center gap-2">
              Comecar a vender <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
