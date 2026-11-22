import { useLayoutEffect, useRef, type ReactNode } from "react";

export function Modal({ title, className, children, cancel, role }: {
  title: string;
  className?: string;
  role?: "alertdialog";
  children: ReactNode;
  cancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const current = dialog.current!;
    current.showModal();
    current.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
    return () => current.close();
  }, []);
  return <dialog ref={dialog} role={role} aria-label={title} className={className} onCancel={(event) => {
    event.preventDefault();
    cancel();
  }}>{children}</dialog>;
}
