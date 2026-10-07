import { useEffect, useRef, useState } from "react";
import "./WorkbenchMenu.css";
import { isImeComposing } from "./imeKeyboard";
export type WorkbenchCommand = {
  label: string;
  run: () => void;
  shortcut?: string;
  disabled?: boolean;
  checked?: boolean;
  separator?: boolean;
};
export function WorkbenchMenu({
  groups,
}: {
  groups: { label: string; items: WorkbenchCommand[] }[];
}) {
  const [open, setOpen] = useState<number | null>(null);
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(null);
    };
    const key = (event: KeyboardEvent) => {
      if (isImeComposing(event)) return;
      if (event.key === "Escape" && open !== null) {
        event.stopPropagation();
        setOpen(null);
        root.current
          ?.querySelector<HTMLButtonElement>(`[data-menu-index="${open}"]`)
          ?.focus();
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", key, true);
    };
  }, [open]);
  const focusItem = (index: number) =>
    requestAnimationFrame(() =>
      root.current
        ?.querySelectorAll<HTMLButtonElement>(
          ".command-popup button:not(:disabled)",
        )
        [index]?.focus(),
    );
  return (
    <nav
      ref={root}
      className="workbench-menubar"
      role="menubar"
      aria-label="工作台菜单"
    >
      {groups.map((group, index) => (
        <div className="command-menu" key={group.label}>
          <button
            role="menuitem"
            data-menu-index={index}
            aria-haspopup="menu"
            aria-expanded={open === index}
            onClick={() => setOpen(open === index ? null : index)}
            onPointerEnter={() => open !== null && setOpen(index)}
            onKeyDown={(event) => {
              if (isImeComposing(event.nativeEvent)) return;
              if (["ArrowDown", "Enter", " "].includes(event.key)) {
                event.preventDefault();
                setOpen(index);
                focusItem(0);
              }
              if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
                event.preventDefault();
                const next =
                  (index +
                    (event.key === "ArrowRight" ? 1 : groups.length - 1)) %
                  groups.length;
                root.current
                  ?.querySelector<HTMLButtonElement>(
                    `[data-menu-index="${next}"]`,
                  )
                  ?.focus();
                if (open !== null) setOpen(next);
              }
            }}
          >
            {group.label}
          </button>
          {open === index && (
            <div
              className="command-popup"
              role="menu"
              aria-label={`${group.label}命令`}
              onKeyDown={(event) => {
                if (isImeComposing(event.nativeEvent)) return;
                if (event.key === "Tab") setOpen(null);
                if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
                  event.preventDefault();
                  setOpen(
                    (index +
                      (event.key === "ArrowRight" ? 1 : groups.length - 1)) %
                      groups.length,
                  );
                  focusItem(0);
                  return;
                }
                const items = [
                  ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    "button:not(:disabled)",
                  ),
                ];
                const i = items.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                if (
                  ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
                ) {
                  event.preventDefault();
                  items[
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? items.length - 1
                        : (i +
                            (event.key === "ArrowDown"
                              ? 1
                              : items.length - 1)) %
                          items.length
                  ]?.focus();
                }
              }}
            >
              {group.items.map((item) => (
                <div key={item.label}>
                  {item.separator && (
                    <div className="command-separator" role="separator" />
                  )}
                  <button
                    role={
                      item.checked === undefined
                        ? "menuitem"
                        : "menuitemcheckbox"
                    }
                    aria-checked={item.checked}
                    disabled={item.disabled}
                    onClick={() => {
                      setOpen(null);
                      root.current
                        ?.querySelector<HTMLButtonElement>(
                          `[data-menu-index="${index}"]`,
                        )
                        ?.focus();
                      item.run();
                    }}
                  >
                    <span className="command-check">
                      {item.checked ? "✓" : ""}
                    </span>
                    <span>{item.label}</span>
                    <kbd>{item.shortcut}</kbd>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </nav>
  );
}
