/** Small presentational pieces shared by server and client components (no hooks). */

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { statusTone } from "../format.ts";

type Variant = "primary" | "normal" | "link" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-primary text-white border-primary hover:bg-primary-hover hover:border-primary-hover hover:text-white hover:no-underline",
  normal: "bg-white text-primary border-primary hover:bg-info-bg hover:text-primary-hover hover:border-primary-hover hover:no-underline",
  danger: "bg-white text-bad border-bad hover:bg-bad-bg hover:text-bad hover:no-underline",
  link: "bg-transparent text-link border-transparent hover:text-link-hover hover:underline",
};

export const inputClass =
  "rounded-[4px] border border-[#879596] bg-white px-2.5 py-1.5 text-[13px] text-ink placeholder:text-[#879596] focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";

export function buttonClass(variant: Variant = "normal"): string {
  return `inline-flex items-center justify-center gap-1.5 rounded-full border-2 px-4 py-[4px] text-[13px] font-bold whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:border-line disabled:bg-shade disabled:text-[#aab7b8] ${VARIANTS[variant]}`;
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

export function Button({ variant = "normal", className = "", type = "button", ...rest }: ButtonProps) {
  return <button type={type} className={`${buttonClass(variant)} ${className}`} {...rest} />;
}

export function Container({
  title,
  description,
  actions,
  children,
  counter,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  counter?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="awsui-card overflow-hidden">
      {(title || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line-soft bg-shade px-5 py-3">
          <div>
            {title && (
              <h2 className="text-[16px] font-bold text-ink">
                {title} {counter !== undefined && <span className="font-normal text-muted">{counter}</span>}
              </h2>
            )}
            {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

const DOT: Record<ReturnType<typeof statusTone>, string> = {
  success: "text-ok",
  error: "text-bad",
  warning: "text-warn",
  pending: "text-accent",
  neutral: "text-muted",
};

function StatusGlyph({ tone }: { tone: ReturnType<typeof statusTone> }) {
  switch (tone) {
    case "success":
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm3.3 5.3-4 4a.75.75 0 0 1-1.06 0l-1.5-1.5a.75.75 0 1 1 1.06-1.06l.97.97 3.47-3.47a.75.75 0 1 1 1.06 1.06z" />
        </svg>
      );
    case "error":
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm2.53 8.47a.75.75 0 1 1-1.06 1.06L8 9.06l-1.47 1.47a.75.75 0 1 1-1.06-1.06L6.94 8 5.47 6.53a.75.75 0 0 1 1.06-1.06L8 6.94l1.47-1.47a.75.75 0 1 1 1.06 1.06L9.06 8l1.47 1.47z" />
        </svg>
      );
    case "warning":
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M8.66 1.7a.75.75 0 0 0-1.32 0L1.1 13.15A.75.75 0 0 0 1.76 14.25h12.48a.75.75 0 0 0 .66-1.1L8.66 1.7zM7.25 6h1.5v4h-1.5V6zm0 5.25h1.5v1.5h-1.5v-1.5z" />
        </svg>
      );
    case "pending":
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <circle cx="8" cy="8" r="6" />
          <path d="M8 4.5V8l2.5 1.5" strokeLinecap="round" />
        </svg>
      );
    default:
      return (
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="8" cy="8" r="5" />
        </svg>
      );
  }
}

export function StatusBadge({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "") return <span>-</span>;
  const tone = statusTone(value);
  return (
    <span className={`inline-flex items-center gap-1.5 font-medium ${DOT[tone]}`}>
      <StatusGlyph tone={tone} />
      <span>{String(value)}</span>
    </span>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="py-10 text-center" data-testid="empty-state">
      <p className="text-[14px] font-bold text-ink">{title}</p>
      {children && <div className="mt-1.5 text-[13px] text-muted">{children}</div>}
    </div>
  );
}

export function ErrorBanner({ title = "Error", message, onDismiss }: { title?: string; message: string; onDismiss?: () => void }) {
  const denied = message.startsWith("AccessDenied");
  return (
    <div
      role="alert"
      className="flex items-start justify-between gap-3 rounded-[2px] border border-bad border-l-4 bg-bad-bg px-4 py-3 text-[13px]"
      data-testid="error-banner"
    >
      <div className="min-w-0">
        <p className="font-bold text-bad">{denied ? "Access denied" : title}</p>
        <p className="mt-0.5 break-words whitespace-pre-wrap text-ink">{message}</p>
      </div>
      {onDismiss && (
        <button type="button" aria-label="Dismiss" className="text-muted hover:text-ink" onClick={onDismiss}>
          ✕
        </button>
      )}
    </div>
  );
}

export function Flash({ kind, message, onDismiss }: { kind: "success" | "info"; message: string; onDismiss?: () => void }) {
  const cls =
    kind === "success"
      ? "border-ok border-l-4 bg-ok-bg text-ink"
      : "border-info-line border-l-4 bg-info-bg text-ink";
  return (
    <div
      role="status"
      className={`flex items-start justify-between gap-3 rounded-[2px] border px-4 py-2.5 text-[13px] ${cls}`}
      data-testid="flash"
    >
      <p className="break-words whitespace-pre-wrap">{message}</p>
      {onDismiss && (
        <button type="button" aria-label="Dismiss" className="text-muted hover:text-ink" onClick={onDismiss}>
          ✕
        </button>
      )}
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-muted" role="status">
      <span className="inline-block size-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent" aria-hidden="true" />
      {label}
    </span>
  );
}

export function PageHeader({ title, counter, description, actions }: { title: ReactNode; counter?: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[22px] font-bold tracking-tight text-ink">
          {title} {counter !== undefined && <span className="font-normal text-muted">{counter}</span>}
        </h1>
        {description && <p className="mt-1 text-[13px] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
