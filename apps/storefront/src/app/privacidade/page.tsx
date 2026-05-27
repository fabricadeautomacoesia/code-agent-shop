import Link from 'next/link';

export const metadata = {
  title: 'Politica de Privacidade - Code & Agent Shop',
  description: 'Politica de privacidade da Code & Agent Shop em conformidade com a LGPD (Lei 13.709/2018).',
  // FIX-WORKER-9 pass 4: canonical explicito
  alternates: { canonical: '/privacidade' },
  // FIX-WORKER-9 pass 5: openGraph especifico
  openGraph: {
    title: 'Politica de Privacidade - Code & Agent Shop',
    description: 'Conformidade LGPD: como tratamos seus dados pessoais.',
    type: 'website',
    url: '/privacidade',
  },
  twitter: {
    card: 'summary',
    title: 'Politica de Privacidade - Code & Agent Shop',
    description: 'Conformidade LGPD.',
  },
};

export default function PrivacidadePage() {
  return (
    // FIX-WORKER-8 pass 2: consistencia visual com /termos (prose prose-invert) e /sobre (glass card).
    // Antes: text direto no fundo da home sem hierarchical separation - looked cheap.
    // Agora: glass panel wrapper + prose plugin para tipografia melhor (margins/spacing automaticos).
    <div className="container mx-auto px-6 py-8 max-w-3xl">
      <Link href="/" className="text-sm text-white/60 hover:text-white not-prose">&larr; Voltar</Link>

      <h1 className="font-display font-bold text-4xl mt-4 mb-2">Politica de Privacidade</h1>
      <p className="text-white/50 text-sm mb-6">Em conformidade com LGPD (Lei 13.709/2018) - 26/05/2026</p>

      <div className="glass p-6 md:p-8 prose prose-invert max-w-none space-y-6 text-white/80">
        <section>
          <h2 className="font-display font-bold text-2xl text-white">1. Dados que coletamos</h2>
          <ul className="list-disc pl-6 space-y-1">
            <li><strong>Cadastro:</strong> nome, email, telefone, CPF/CNPJ</li>
            <li><strong>Autenticacao:</strong> hash bcrypt da senha, segredo 2FA criptografado AES-256</li>
            <li><strong>Pagamento:</strong> processado pelo Asaas - nao armazenamos dados de cartao</li>
            <li><strong>Tecnicos:</strong> IP, user agent, timestamps de login, browser fingerprint</li>
            <li><strong>Comportamento:</strong> historico de buscas, produtos visualizados, compras</li>
          </ul>
        </section>

        <section>
          <h2 className="font-display font-bold text-2xl text-white">2. Como usamos</h2>
          <ul className="list-disc pl-6 space-y-1">
            <li>Operar a plataforma (login, vendas, downloads, suporte)</li>
            <li>Prevenir fraude (Fail2Ban, spike detection, audit log)</li>
            <li>Calcular reputacao de vendedores</li>
            <li>Recomendar produtos (search log, trending)</li>
            <li>Enviar comunicacoes transacionais (pedidos, disputas, SLA)</li>
            <li>Cumprir obrigacoes legais e fiscais</li>
          </ul>
        </section>

        <section>
          <h2 className="font-display font-bold text-2xl text-white">3. Bases legais (LGPD Art. 7)</h2>
          <ul className="list-disc pl-6 space-y-1">
            <li><strong>Execucao de contrato:</strong> operacao do marketplace</li>
            <li><strong>Consentimento:</strong> marketing e analytics</li>
            <li><strong>Legitimo interesse:</strong> seguranca + prevencao a fraude</li>
            <li><strong>Cumprimento legal:</strong> dados fiscais e LGPD/Marco Civil</li>
          </ul>
        </section>

        <section>
          <h2 className="font-display font-bold text-2xl text-white">4. Compartilhamento</h2>
          <p>Compartilhamos dados apenas com:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li><strong>Asaas:</strong> processamento de pagamentos (PIX/Cartao/Boleto)</li>
            <li><strong>Provedores LLM</strong> (OpenAI/Gemini/Groq): apenas conteudo do produto submetido para QA, nunca dados pessoais</li>
            <li><strong>Provedor de email</strong> (Gmail SMTP): apenas seu email + conteudo da mensagem transacional</li>
            <li><strong>Autoridades:</strong> mediante ordem judicial</li>
          </ul>
          <p className="mt-3"><strong>Nao vendemos dados pessoais a terceiros.</strong></p>
        </section>

        <section>
          <h2 className="font-display font-bold text-2xl text-white">5. Seguranca</h2>
          <ul className="list-disc pl-6 space-y-1">
            <li>Senhas: bcrypt cost 12</li>
            <li>2FA TOTP: AES-256-GCM no banco</li>
            <li>API keys de terceiros (cofre): AES-256-GCM</li>
            <li>JWT duplo: access 15min + refresh 7d HTTP-only Secure</li>
            <li>Fail2Ban: 5 falhas = ban 15min</li>
            <li>HTTPS obrigatorio (Lets Encrypt auto-renew)</li>
            <li>Helmet CSP estrito + sanitizacao anti-XSS</li>
            <li>Audit log imutavel para acoes sensiveis</li>
            <li>Backup pg_dump a cada 6h com retencao 7 dias</li>
          </ul>
        </section>

        <section>
          <h2 className="font-display font-bold text-2xl text-white">6. Seus direitos (LGPD Art. 18)</h2>
          <p>Voce pode solicitar a qualquer momento via email:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Confirmacao de existencia de tratamento</li>
            <li>Acesso aos seus dados</li>
            <li>Correcao de dados incompletos/desatualizados</li>
            <li>Anonimizacao, bloqueio ou eliminacao de dados desnecessarios</li>
            <li>Portabilidade dos dados</li>
            <li>Revogacao de consentimento</li>
            <li>Informacao sobre compartilhamento</li>
          </ul>
        </section>

        <section>
          <h2 className="font-display font-bold text-2xl text-white">7. Retencao</h2>
          <ul className="list-disc pl-6 space-y-1">
            <li>Dados cadastrais: enquanto a conta estiver ativa + 5 anos (obrigacao fiscal)</li>
            <li>Metrics e logs: 30 dias</li>
            <li>Search log: 30 dias</li>
            <li>Vault keys revogadas: 90 dias</li>
            <li>Backups: 7 dias rotativos</li>
          </ul>
        </section>

        <section>
          <h2 className="font-display font-bold text-2xl text-white">8. Cookies</h2>
          <p>Usamos cookies essenciais:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li><code>cas_rt</code>: refresh token (HttpOnly, Secure, SameSite=Lax, 7d)</li>
            <li><code>cas_auth</code> (localStorage): access token (15min)</li>
          </ul>
          <p>Nao usamos cookies de tracking de terceiros.</p>
        </section>

        <section>
          <h2 className="font-display font-bold text-2xl text-white">9. Contato DPO</h2>
          <p>
            Encarregado de Dados: Inovare AI Ecosystem<br />
            Email: <a href="mailto:fabricadeautomacoes0@gmail.com" className="text-magenta">fabricadeautomacoes0@gmail.com</a>
          </p>
        </section>
      </div>
    </div>
  );
}
