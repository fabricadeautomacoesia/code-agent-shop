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
};

export function friendlyAuthError(e: any): string {
  // ApiError tem { message: code, data: { error, message, details? } }
  const code = e?.message || e?.data?.error || '';
  if (ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];

  // validation_error com details[0]: extrai path + reason
  if (code === 'validation_error' && e?.data?.details?.length) {
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

  // Fallback: usa message do backend se humanizada, senao mensagem generica
  const backendMsg = e?.data?.message;
  if (backendMsg && !/^[a-z_]+$/.test(backendMsg)) return backendMsg;

  return 'Erro ao processar requisicao. Tente novamente.';
}
