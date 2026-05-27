'use client';

/**
 * <Dialog> wrapper DRY para modals/drawers WCAG 2.1 compliant.
 *
 * FIX-WORKER-3 pass 9 (DRY): pattern dialog estabelecido em pass 7+8
 * (NotificationBell, CartDrawer, nav mobile menu, SearchAutocomplete,
 * AskQuickButton) duplicado 5x. Cada componente reimplementava:
 *
 *   1. role="dialog" + aria-modal="true"
 *   2. aria-labelledby OU aria-label
 *   3. Escape key listener via useEffect + cleanup
 *   4. Body scroll lock (overflow:hidden + restore)
 *   5. Backdrop semantico <button aria-label> em vez de <div onClick>
 *   6. Focus management (auto-focus primeiro element + return ao opener)
 *   7. z-index escalation z-[60]/z-[70]
 *
 * Reusar 5+ vezes = bug a quebrar 1 do 5 = WCAG fail silencioso futuro
 * + manutencao 5x trabalho. DRY agora.
 *
 * Uso:
 *   <Dialog open={open} onClose={() => setOpen(false)} title="Carrinho"
 *           ariaLabel="Carrinho de compras" variant="drawer-right">
 *     <YourContent />
 *   </Dialog>
 *
 * Variants:
 *   - 'centered': modal centralizado (AskQuickButton, search)
 *   - 'drawer-right': drawer lateral direito (CartDrawer, nav mobile)
 *   - 'drawer-left': drawer lateral esquerdo (futuro)
 */

import { useEffect, useRef, type ReactNode } from 'react';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  /** Texto do header h2 - rendrizado se fornecido + linkado via aria-labelledby */
  title?: string;
  /** aria-label fallback quando nao ha title visivel (ex: search) */
  ariaLabel?: string;
  /** Estilo de posicionamento - default 'centered' */
  variant?: 'centered' | 'drawer-right' | 'drawer-left';
  /** Z-index base - default 60 (cart=60, modals=80) */
  zIndex?: number;
  /** Classes adicionais no container interno (overrides defaults) */
  className?: string;
  /** Label do botao close (X) - default 'Fechar' */
  closeLabel?: string;
  /** Se true, NAO mostra X no header (caller responsavel). Default false */
  hideCloseButton?: boolean;
  children: ReactNode;
}

let dialogIdCounter = 0;

export function Dialog({
  open,
  onClose,
  title,
  ariaLabel,
  variant = 'centered',
  zIndex = 60,
  className,
  closeLabel = 'Fechar',
  hideCloseButton = false,
  children,
}: DialogProps) {
  // ID estavel cross-render para aria-labelledby (evita collision multi-instance)
  const titleIdRef = useRef<string>('');
  if (!titleIdRef.current) {
    titleIdRef.current = `dialog-title-${++dialogIdCounter}`;
  }
  const openerElementRef = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // 1+2+3+4: Escape + body scroll lock + focus management
  useEffect(() => {
    if (!open) return;

    // Captura elemento que tinha foco antes de abrir (return focus on close)
    openerElementRef.current = document.activeElement as HTMLElement;

    // Body scroll lock
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Escape key listener
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);

    // Auto-focus primeiro elemento focusavel dentro do dialog (a11y best practice)
    // Pequeno timeout para garantir DOM mount
    const focusTimer = setTimeout(() => {
      const first = dialogRef.current?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      first?.focus();
    }, 50);

    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      clearTimeout(focusTimer);
      // 6: Return focus to opener (a11y essential)
      // querySelector falhar em element removido eh ok - try/catch defensive
      try { openerElementRef.current?.focus(); } catch {}
    };
  }, [open, onClose]);

  if (!open) return null;

  // Position classes por variant
  const positionClass =
    variant === 'drawer-right' ? 'flex justify-end' :
    variant === 'drawer-left'  ? 'flex justify-start' :
                                  'flex items-center justify-center p-4';

  const innerDefaultClass =
    variant === 'drawer-right' || variant === 'drawer-left'
      ? 'relative w-full max-w-md glass-strong h-full flex flex-col rounded-none border-l border-white/10'
      : 'relative glass-strong rounded-2xl shadow-2xl max-w-md w-full';

  const innerClass = className || innerDefaultClass;
  const labelledBy = title ? titleIdRef.current : undefined;

  return (
    <div className={`fixed inset-0 z-[${zIndex}] ${positionClass}`} style={{ zIndex }}>
      {/* 5: Backdrop semantico - <button> em vez de <div onClick>. cursor-default
          para nao parecer pointer-button (visual hint backdrop, nao card-action) */}
      <button type="button"
        aria-label={closeLabel}
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm cursor-default" />
      {/* 1+2: role="dialog" + aria-modal + aria-labelledby/aria-label */}
      <div ref={dialogRef}
        role="dialog"
        aria-modal="true"
        {...(labelledBy ? { 'aria-labelledby': labelledBy } : {})}
        {...(!labelledBy && ariaLabel ? { 'aria-label': ariaLabel } : {})}
        className={innerClass}>
        {title && !hideCloseButton && (
          <header className="flex items-center justify-between p-5 border-b border-white/10">
            <h2 id={titleIdRef.current} className="font-display font-bold text-xl">
              {title}
            </h2>
            <button onClick={onClose}
              aria-label={closeLabel}
              className="p-2 hover:bg-white/5 rounded-lg focus-visible:outline-2 focus-visible:outline-magenta">
              {/* X svg inline para evitar dep extra lucide neste wrapper base */}
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </header>
        )}
        {title && hideCloseButton && (
          // title visible mas X custom no caller (ex: header com botoes extras)
          <h2 id={titleIdRef.current} className="sr-only">{title}</h2>
        )}
        {children}
      </div>
    </div>
  );
}
