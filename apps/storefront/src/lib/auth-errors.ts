/**
 * FIX-WORKER-6: mapeamento de codigos de erro da auth-svc -> mensagens PT-BR amigaveis.
 *
 * Backend retorna {error: "validation_error", message: "Falha de validacao", details: [...]}
 * Antes: UI mostrava setError(e.message) -> "validation_error" generico e sem acao.
 * Agora: friendlyAuthError(e) inspeciona codigo + details[0]?.path para mensagem util.
 */

const ERROR_MESSAGES: Record<string, string> = {
  // Login / register
  invalid_credentials:    'Email ou senha incorretos.',
  email_already_in_use:   'Este email ja esta cadastrado. Tente fazer login.',
  user_not_found:         'Usuario nao encontrado.',
  missing_token:          'Sessao expirada. Faca login novamente.',
  token_expired:          'Sessao expirada. Faca login novamente.',
  invalid_token:          'Codigo invalido. Verifique e tente novamente.',
  invalid_password:       'Senha incorreta.',
  missing_refresh:        'Sessao expirada. Faca login novamente.',
  refresh_expired:        'Sessao expirada. Faca login novamente.',
  refresh_invalid:        'Sessao invalida. Faca login novamente.',

  // 2FA
  not_set_up:             '2FA ainda nao foi configurado.',
  '2fa_not_enabled':      '2FA nao esta ativado.',
  twofa_required:         'Codigo 2FA obrigatorio para esta conta.',
  twofa_corrupt:          'Erro nos dados 2FA. Contate o suporte.',
  invalid_2fa_code:       'Codigo 2FA invalido. Verifique no seu app autenticador.',

  // Password reset
  reset_token_expired:    'Link de redefinicao expirado. Solicite outro.',
  reset_token_invalid:    'Link de redefinicao invalido.',

  // Generic
  forbidden_role:         'Sua conta nao tem permissao para esta acao.',
  account_suspended:      'Conta suspensa. Contate o suporte.',
  rate_limited:           'Muitas tentativas. Aguarde alguns minutos.',
  validation_error:       'Dados invalidos. Verifique os campos.',

  // Payment / Checkout
  missing_cpf_cnpj:       'CPF/CNPJ obrigatorio para pagamento. Complete seu cadastro em Minha Conta antes de finalizar.',
  payment_not_pending:    'Este pedido nao esta pendente de pagamento.',
  order_not_found:        'Pedido nao encontrado.',
  empty_cart:             'Seu carrinho esta vazio.',

  // Profile / CPF validation (W2 pass 5 auth-svc)
  invalid_cpf:            'CPF invalido. Verifique os digitos (algoritmo Receita Federal).',
  invalid_cnpj:           'CNPJ invalido. Verifique os digitos (algoritmo Receita Federal).',
  invalid_cpf_cnpj_length:'CPF precisa ter 11 digitos ou CNPJ 14 digitos.',
};

export function friendlyAuthError(e: any): string {
  // FIX-WORKER-8 pass 3: prioridade inversa pos-W8 pass 2.
  // W8 pass 2 mudou api.ts para preferir data.message (PT-BR humano) sobre
  // data.error (machine code) ao construir ApiError. Isso QUEBRAVA o mapping:
  //   ANTES: e.message='invalid_credentials' -> ERROR_MESSAGES[code] OK
  //   DEPOIS pass 2: e.message='Email ou senha incorretos.' -> mapping FAIL
  //                  -> caia no fallback regex (acidentalmente funcionou pq
  //                  backend mandou PT-BR, MAS se backend mandar EN/codigo
  //                  cru ou validation, friendly-errors nao detectava)
  // FIX: code SEMPRE de e.data.error (machine - estavel pelo backend)
  //      e.message como fallback humano (ja PT-BR pelo W8 pass 2)
  const code = e?.data?.error || '';

  // 1. Mapping codigo machine -> mensagem PT-BR curada (melhor UX)
  if (ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];

  // validation_error com details[0]: extrai path + reason
  // FIX pass 111: bloco if estava OK mas faltava abertura - sintaxe quebrada
  if (e?.data?.error === 'validation_error' && Array.isArray(e?.data?.details) && e.data.details[0]) {
    const d = e.data.details[0];
    const field = Array.isArray(d.path) ? d.path[d.path.length - 1] : d.path;
    // FIX-WORKER-1 pass 2: mensagens PT-BR especificas por campo (UX > generico)
    const FIELD_HINTS: Record<string, string> = {
      phone_e164: 'Telefone: use formato internacional +5511999999999 (com codigo do pais).',
      email:      'Email: digite um email valido (exemplo@dominio.com).',
      cpf_cnpj:   'CPF/CNPJ: digite apenas numeros, 11 ou 14 digitos.',
      password:   'Senha: minimo 8 caracteres, com letra maiuscula e numero.',
      full_name:  'Nome completo: minimo 2 caracteres.',
    };
    if (d.code === 'invalid_string' && FIELD_HINTS[field]) {
      return FIELD_HINTS[field];
    }
    if (d.code === 'too_small') {
      if (FIELD_HINTS[field]) return FIELD_HINTS[field];
      return `${field}: deve ter pelo menos ${d.minimum} caractere(s).`;
    }
    if (d.code === 'invalid_type') {
      return `Campo obrigatorio: ${field}.`;
    }
    if (d.code === 'invalid_string') {
      return `${field}: formato invalido.`;
    }
    return `${field}: ${d.message || 'valor invalido'}.`;
  }

  // FIX-WORKER-8 pass 3: Fallback chain alinhada com api.ts pos-W8 pass 2.
  // e.message agora vem da chain (data.message || data.error_pt_br || data.error || http_N)
  // entao se code nao bate no mapping, e.message ja eh a melhor mensagem humana disponivel.
  // Filtros para nao mostrar codigos crus ao user:
  //  - /^[a-z_]+$/: snake_case machine codes (ex: 'invalid_credentials')
  //  - /^http_\d+$/: codigo HTTP fallback final api.ts
  //  - Strings vazias / null
  const humanMsg = e?.message || e?.data?.message || '';
  const isMachineCode = !humanMsg ||
    /^[a-z_]+$/.test(humanMsg) ||
    /^http_\d+$/.test(humanMsg);
  if (!isMachineCode) return humanMsg;

  // Last resort: codigo cru detectado, mostrar generico (anti-machine-code-leak ao user)
  return 'Erro ao processar requisicao. Tente novamente.';
}
