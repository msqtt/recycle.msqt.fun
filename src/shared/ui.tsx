import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ');

export function NeoButton({
  color = 'bg-lemon', className, ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { color?: string }) {
  return (
    <button
      {...props}
      className={cx(
        'border-2 border-ink px-4 py-1.5 font-bold shadow-neo-sm transition-all',
        'hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none',
        'disabled:opacity-50 disabled:pointer-events-none',
        color, className,
      )}
    />
  );
}

export function NeoCard({ children, className, color = 'bg-white' }: { children: ReactNode; className?: string; color?: string }) {
  return <div className={cx('border-2 border-ink shadow-neo p-4', color, className)}>{children}</div>;
}

export function NeoInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cx('border-2 border-ink px-3 py-1.5 bg-white w-full focus:outline-none focus:bg-lemon/30 font-mono text-sm', className)}
    />
  );
}

export function NeoTextarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={cx('border-2 border-ink px-3 py-1.5 bg-white w-full focus:outline-none focus:bg-lemon/30 font-mono text-sm', className)}
    />
  );
}

export function NeoSelect({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={cx('border-2 border-ink px-3 py-1.5 bg-white font-bold focus:outline-none', className)}>
      {children}
    </select>
  );
}

const badgeColors: Record<string, string> = {
  ok: 'bg-lime', succeeded: 'bg-lime', running: 'bg-sky', 'waiting-human': 'bg-tang',
  'paused-human': 'bg-tang', failed: 'bg-punch', cancelled: 'bg-grape', skipped: 'bg-gray-200',
  pending: 'bg-gray-100', ready: 'bg-sky', degraded: 'bg-tang', unreachable: 'bg-punch',
  unknown: 'bg-gray-100', preserving: 'bg-punch', loading: 'bg-gray-100', handshaking: 'bg-gray-100',
  wtop: 'bg-sky', http: 'bg-grape',
};

export function NeoBadge({ children, tone }: { children: ReactNode; tone?: string }) {
  return (
    <span className={cx('inline-block border-2 border-ink px-2 py-0.5 text-xs font-bold uppercase', badgeColors[tone ?? ''] ?? 'bg-lemon')}>
      {children}
    </span>
  );
}

export function NeoModal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-ink/40 p-4" onClick={onClose}>
      <div
        className={cx('border-2 border-ink bg-paper shadow-neo-lg max-h-[85vh] overflow-auto w-full', wide ? 'max-w-4xl' : 'max-w-xl')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b-2 border-ink bg-lemon px-4 py-2">
          <h2 className="font-bold uppercase">{title}</h2>
          <button onClick={onClose} className="border-2 border-ink bg-white px-2 font-bold shadow-neo-sm hover:shadow-none">✕</button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export function PageTitle({ children, sub }: { children: ReactNode; sub?: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-3xl font-black uppercase tracking-tight inline-block bg-lime border-2 border-ink shadow-neo px-3 py-1">
        {children}
      </h1>
      {sub && <p className="mt-2 text-sm font-mono">{sub}</p>}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block mb-3">
      <span className="block text-xs font-bold uppercase mb-1">{label}</span>
      {children}
      {hint && <span className="block text-xs text-ink/60 mt-1">{hint}</span>}
    </label>
  );
}