import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
export function Modal({
  title,
  subtitle,
  children,
  close,
  className = "",
  eyebrow = "tmp.cash / WALLET",
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  close: () => void;
  className?: string;
  eyebrow?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    titleId = useId();
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  useEffect(() => {
    ref.current?.scrollTo(0, 0);
  }, [title]);
  return (
    <dialog
      ref={ref}
      className={"modal " + className}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === ref.current) {
          const bounds = ref.current.getBoundingClientRect();
          if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
          )
            close();
        }
      }}
    >
      <button
        className="icon-button modal-close"
        aria-label="Close dialog"
        onClick={close}
      >
        <X size={20} />
      </button>
      <span className="eyebrow">{eyebrow}</span>
      <h2 id={titleId}>{title}</h2>
      {subtitle && <p className="muted">{subtitle}</p>}
      {children}
    </dialog>
  );
}
