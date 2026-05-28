'use client';

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

/**
 * FIX-WORKER-4 pass 149: substitui window.prompt() nativo por modal
 * acessivel + estilizado para acoes admin (reject payout, suspend seller).
 *
 * Por que substituir window.prompt:
 * - a11y: prompt nativo nao tem focus management nem aria
 * - UX: parece sketchy em dashboard admin glassmorphism
 * - mobile: prompt nativo pequeno + mal-formatado em iOS/Android
 * - i18n: nao pode estilizar/traduzir OK/Cancel
 *
 * Uso (async/await):
 *   const reason = await prompt('Motivo da rejeicao:');
 *   if (!reason) return; // user cancelou
 *
 * Componente expõe via Promise + state externo (singleton pattern).
 * Usuario chama promptDialog() em qualquer lugar - retorna Promise<string|null>.
 */

type Resolver = (value: string | null) => void;

interface PromptState {
  open: boolean;
  title: string;
  placeholder?: string;
  defaultValue?: string;
  resolver: Resolver | null;
}

let setStateExternal: ((s: PromptState) => void) | null = null;

/**
 * Helper imperativo: substitui window.prompt() em qualquer codigo.
 *
 * @param title - mensagem para o user (ex: 'Motivo da rejeicao:')
 * @param placeholder - placeholder do input (opcional)
 * @returns Promise<string | null> - string se confirmou, null se cancelou/vazio
 */
export function promptDialog(title: string, placeholder?: string, defaultValue?: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (!setStateExternal) {
      // Fallback se PromptDialogProvider nao foi montado (defensive)
      const val = window.prompt(title, defaultValue || '');
      resolve(val);
      return;
    }
    setStateExternal({
      open: true,
      title,
      placeholder,
      defaultValue,
      resolver: resolve,
    });
  });
}

/**
 * Provider global que renderiza o modal singleton.
 * Montar 1x no root layout.tsx do dashboard-admin.
 */
export function PromptDialogProvider() {
  const [state, setState] = useState<PromptState>({
    open: false,
    title: '',
    resolver: null,
  });
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setStateExternal = setState;
    return () => { setStateExternal = null; };
  }, []);

  useEffect(() => {
    if (state.open) {
      setValue(state.defaultValue || '');
      // Focus auto no input apos render
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [state.open, state.defaultValue]);

  // Esc fecha como cancelar
  useEffect(() => {
    if (!state.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        cancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.open]);

  function confirm() {
    const trimmed = value.trim();
    state.resolver?.(trimmed || null);
    setState({ open: false, title: '', resolver: null });
    setValue('');
  }

  function cancel() {
    state.resolver?.(null);
    setState({ open: false, title: '', resolver: null });
    setValue('');
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    confirm();
  }

  if (!state.open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="prompt-title"
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) cancel(); }}
    >
      <div className="glass-strong rounded-xl max-w-md w-full shadow-2xl">
        <div className="flex items-center justify-between p-4 border-b border-white/10">
          <h3 id="prompt-title" className="font-display font-bold text-base">{state.title}</h3>
          <button
            type="button"
            onClick={cancel}
            aria-label="Cancelar"
            className="p-1 rounded hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-magenta"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
        <form onSubmit={onSubmit} className="p-4 space-y-4">
          <div>
            <label htmlFor="prompt-input" className="sr-only">{state.title}</label>
            <input
              ref={inputRef}
              id="prompt-input"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={state.placeholder || ''}
              autoComplete="off"
              className="w-full px-3 py-2.5 rounded-lg bg-white/5 border border-white/10 focus:border-magenta focus:outline-none text-sm"
            />
          </div>
          <div className="flex items-center gap-2 justify-end">
            <button
              type="button"
              onClick={cancel}
              className="px-4 py-2 rounded-lg text-sm hover:bg-white/5 transition-colors focus-visible:outline-2 focus-visible:outline-magenta"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={!value.trim()}
              className="btn-primary text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Confirmar
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
