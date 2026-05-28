'use client';

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

/**
 * FIX-WORKER-5 pass 151: PromptDialog + confirmDialog para seller dashboard.
 * Cópia exata do componente admin (pass 149-150) - mantém consistência cross-dashboard.
 *
 * Substituições atuais (pass 151):
 * - /products lista: confirm 'Enviar para QA'
 * - /products/[id] edit: confirm 'Enviar para QA'
 */

type Resolver = (value: string | null) => void;
type ConfirmResolver = (value: boolean) => void;

interface PromptState {
  open: boolean;
  mode: 'prompt' | 'confirm';
  title: string;
  body?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  confirmVariant?: 'primary' | 'danger';
  resolver: Resolver | null;
  confirmResolver: ConfirmResolver | null;
}

let setStateExternal: ((s: PromptState) => void) | null = null;

export function promptDialog(title: string, placeholder?: string, defaultValue?: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (!setStateExternal) {
      const val = window.prompt(title, defaultValue || '');
      resolve(val);
      return;
    }
    setStateExternal({
      open: true,
      mode: 'prompt',
      title,
      placeholder,
      defaultValue,
      resolver: resolve,
      confirmResolver: null,
    });
  });
}

export function confirmDialog(
  title: string,
  opts?: { body?: string; confirmLabel?: string; variant?: 'primary' | 'danger' }
): Promise<boolean> {
  return new Promise((resolve) => {
    if (!setStateExternal) {
      const ok = window.confirm(opts?.body ? `${title}\n\n${opts.body}` : title);
      resolve(ok);
      return;
    }
    setStateExternal({
      open: true,
      mode: 'confirm',
      title,
      body: opts?.body,
      confirmLabel: opts?.confirmLabel || 'Confirmar',
      confirmVariant: opts?.variant || 'primary',
      resolver: null,
      confirmResolver: resolve,
    });
  });
}

export function PromptDialogProvider() {
  const [state, setState] = useState<PromptState>({
    open: false,
    mode: 'prompt',
    title: '',
    resolver: null,
    confirmResolver: null,
  });
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setStateExternal = setState;
    return () => { setStateExternal = null; };
  }, []);

  useEffect(() => {
    if (state.open) {
      setValue(state.defaultValue || '');
      setTimeout(() => {
        if (state.mode === 'prompt') inputRef.current?.focus();
        else confirmBtnRef.current?.focus();
      }, 50);
    }
  }, [state.open, state.defaultValue, state.mode]);

  useEffect(() => {
    if (!state.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.open]);

  function confirm() {
    if (state.mode === 'confirm') {
      state.confirmResolver?.(true);
    } else {
      const trimmed = value.trim();
      state.resolver?.(trimmed || null);
    }
    setState({ open: false, mode: 'prompt', title: '', resolver: null, confirmResolver: null });
    setValue('');
  }

  function cancel() {
    if (state.mode === 'confirm') {
      state.confirmResolver?.(false);
    } else {
      state.resolver?.(null);
    }
    setState({ open: false, mode: 'prompt', title: '', resolver: null, confirmResolver: null });
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
          {state.body && (
            <p className="text-sm text-white/70 whitespace-pre-line">{state.body}</p>
          )}
          {state.mode === 'prompt' && (
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
          )}
          <div className="flex items-center gap-2 justify-end">
            <button
              type="button"
              onClick={cancel}
              className="px-4 py-2 rounded-lg text-sm hover:bg-white/5 transition-colors focus-visible:outline-2 focus-visible:outline-magenta"
            >
              Cancelar
            </button>
            <button
              ref={confirmBtnRef}
              type="submit"
              disabled={state.mode === 'prompt' && !value.trim()}
              className={`text-sm disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 rounded-lg font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-magenta ${
                state.confirmVariant === 'danger'
                  ? 'bg-red-500/20 border border-red-500/40 text-red-300 hover:bg-red-500/30'
                  : 'btn-primary'
              }`}
            >
              {state.mode === 'confirm' ? (state.confirmLabel || 'Confirmar') : 'Confirmar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
