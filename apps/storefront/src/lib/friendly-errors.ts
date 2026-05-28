/**
 * FIX-WORKER-3 pass 10 (DRY): consolida 3 friendly-error mappers que estavam
 * inline em components/add-to-cart.tsx, qna-form.tsx, review-form.tsx.
 *
 * Cada mapper segue padrao identico:
 *   1. Olha e?.data?.error || e?.message como codigo
 *   2. Procura no record dedicado (CART/QNA/REVIEW _ERRORS)
 *   3. Se 'validation_error', inspeciona e?.data?.details[0] para sub-error
 *      por d.code (too_small/too_big/invalid_type) e d.path (campo)
 *   4. Fallback generico em portugues
 *
 * Auth/cadastro tem seu proprio mapper em lib/auth-errors.ts (escopo diferente
 * - erros 2FA, tokens reset, etc). Mantido separado para nao acoplar dominios.
 *
 * Pattern para extender: novo dominio (payments, reviews-fav, etc) cria seu
 * record + funcao friendlyXxxError. Componentes usam diretamente, sem inline copy.
 */

// ============================================================
// CART (add-to-cart, cart drawer)
// ============================================================
const CART_ERROR_MESSAGES: Record<string, string> = {
  product_not_available: 'Produto indisponivel ou foi removido.',
  product_not_found:     'Produto nao encontrado.',
  validation_error:      'Dados invalidos. Tente novamente.',
  cart_locked:           'Carrinho temporariamente bloqueado. Aguarde alguns segundos.',
  forbidden_role:        'Sua conta nao tem permissao para esta acao.',
  rate_limited:          'Muitas requisicoes. Aguarde alguns minutos.',
};

export function friendlyCartError(e: any): string {
  const code = e?.data?.error || e?.message || '';
  if (CART_ERROR_MESSAGES[code]) return CART_ERROR_MESSAGES[code];
  if (code === 'validation_error' && e?.data?.details?.length) {
    const d = e.data.details[0];
    const field = Array.isArray(d.path) ? d.path[d.path.length - 1] : d.path;
    if (d.code === 'too_big' && field === 'quantity') return 'Quantidade maxima por item: 99.';
    return `Campo ${field}: ${d.message || 'invalido'}`;
  }
  return 'Erro ao adicionar ao carrinho. Tente novamente.';
}

// ============================================================
// QNA (qna-form, ask-quick-button)
// ============================================================
const QNA_ERROR_MESSAGES: Record<string, string> = {
  product_not_found:      'Produto nao encontrado ou foi removido.',
  spam_detected:          'Pergunta detectada como spam. Reformule de modo educado.',
  duplicate_question:     'Voce ja fez uma pergunta similar neste produto recentemente.',
  rate_limited:           'Voce esta perguntando muito rapido. Aguarde alguns minutos.',
  forbidden_role:         'Apenas compradores cadastrados podem fazer perguntas.',
  question_too_short:     'Pergunta muito curta. Use ao menos 5 caracteres.',
  question_too_long:      'Pergunta muito longa. Limite de 2000 caracteres.',
};

export function friendlyQnaError(e: any): string {
  const code = e?.data?.error || e?.message || '';
  if (QNA_ERROR_MESSAGES[code]) return QNA_ERROR_MESSAGES[code];
  if (code === 'validation_error' && e?.data?.details?.length) {
    const d = e.data.details[0];
    if (d.code === 'too_small') return 'Pergunta muito curta (minimo 5 caracteres).';
    if (d.code === 'too_big')   return 'Pergunta muito longa (maximo 2000 caracteres).';
    return `Campo invalido: ${d.message || 'erro de validacao'}`;
  }
  return 'Erro ao enviar pergunta. Tente novamente em instantes.';
}

// ============================================================
// REVIEW (review-form)
// ============================================================
const REVIEW_ERROR_MESSAGES: Record<string, string> = {
  already_reviewed:       'Voce ja avaliou este produto.',
  forbidden_not_buyer:    'Apenas compradores verificados podem avaliar.',
  order_not_paid:         'O pedido precisa estar pago para avaliacao.',
  order_not_fulfilled:    'Aguarde o produto ser entregue antes de avaliar.',
  product_not_found:      'Produto nao encontrado ou foi removido.',
  rate_limited:           'Muitas avaliacoes em pouco tempo. Aguarde alguns minutos.',
  spam_detected:          'Avaliacao detectada como spam. Reformule sem links.',
};

export function friendlyReviewError(e: any): string {
  const code = e?.data?.error || e?.message || '';
  if (REVIEW_ERROR_MESSAGES[code]) return REVIEW_ERROR_MESSAGES[code];
  if (code === 'validation_error' && e?.data?.details?.length) {
    const d = e.data.details[0];
    const field = Array.isArray(d.path) ? d.path[d.path.length - 1] : d.path;
    if (d.code === 'too_big' && field === 'title') return 'Titulo muito longo (max 200 caracteres).';
    if (d.code === 'too_big' && field === 'body')  return 'Comentario muito longo (max 5000 caracteres).';
    if (d.code === 'invalid_type' && field === 'rating') return 'Selecione uma nota de 1 a 5 estrelas.';
    return `Campo ${field}: ${d.message || 'invalido'}`;
  }
  return 'Erro ao publicar avaliacao. Tente novamente em instantes.';
}

// ============================================================
// CHECKOUT (cart -> checkout flow)
// W2 pass 196: friendly UX p/ checkout errors backend (order-svc)
// ============================================================
const CHECKOUT_ERROR_MESSAGES: Record<string, string> = {
  empty_cart:                    'Seu carrinho esta vazio. Adicione produtos antes de finalizar.',
  rate_limited:                  'Voce fez muitas tentativas de checkout. Aguarde alguns minutos.',
  insufficient_points_at_checkout: 'Saldo de pontos insuficiente. Remova o resgate ou ajuste a quantidade.',
  product_unavailable:           'Um ou mais produtos no carrinho ficaram indisponiveis. Recarregue a pagina.',
  payment_method_unsupported:    'Metodo de pagamento nao suportado neste momento.',
  installment_count_invalid:     'Parcelamento exige cartao de credito.',
  validation_error:              'Dados invalidos. Verifique os campos e tente novamente.',
  forbidden_role:                'Sua conta nao tem permissao para finalizar compras.',
};

export function friendlyCheckoutError(e: any): string {
  // FIX-WORKER-2 pass 196: status 429 (rate-limit do checkoutLimiter)
  // pode chegar sem error code legivel - detect by status.
  if (e?.status === 429 || e?.data?.statusCode === 429) {
    return CHECKOUT_ERROR_MESSAGES.rate_limited;
  }
  const code = e?.data?.error || e?.message || '';
  if (CHECKOUT_ERROR_MESSAGES[code]) return CHECKOUT_ERROR_MESSAGES[code];
  if (code === 'validation_error' && e?.data?.details?.length) {
    const d = e.data.details[0];
    const field = Array.isArray(d.path) ? d.path[d.path.length - 1] : d.path;
    if (field === 'installment_count') return CHECKOUT_ERROR_MESSAGES.installment_count_invalid;
    return `Campo ${field}: ${d.message || 'invalido'}`;
  }
  // backend error message pode ja ser legivel (rejected_reason, etc)
  if (e?.data?.message) return e.data.message;
  return 'Erro ao finalizar compra. Tente novamente em instantes.';
}
