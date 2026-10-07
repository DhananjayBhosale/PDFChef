import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React from 'react';
import { Moon, Sun } from 'lucide-react';
import { useAppearance } from '../../hooks/useAppearance';

export const ThemeToggle: React.FC = () => {
  useI18n();
  const { resolvedTheme, setTheme } = useAppearance();
  const next = resolvedTheme === 'dark' ? 'light' : 'dark';

  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={t(`theme.switch.${next}`)}
      className="chef-pressable chef-target grid place-items-center rounded-[var(--radius-control)] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)]"
    >
      {resolvedTheme === 'light' ? <Moon aria-hidden size={18} /> : <Sun aria-hidden size={18} />}
    </button>
  );
};
