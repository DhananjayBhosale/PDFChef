import React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import { useOpenedPdf } from '../../hooks/useOpenedPdf';
import { pickedFileOn } from './dropZone';

/** The tools an error can send the user to next, drawn as links inside the message (T-09). */
const NEXT_STEPS = [
  {
    name: () => t('tool-catalog.unlock.pdf.893947'),
    to: '/unlock',
    // Locked-file messages that ask for Unlock PDF without (in some languages) naming it.
    keys: ['error.pdfLocked', 'compress-pdf.this.pdf.is.encrypted.unlock.it.first.7621b1'] as const,
  },
  { name: () => t('tool-catalog.repair.pdf.43faa0'), to: '/repair', keys: [] as const },
];

/**
 * An error's words, with the next tool it names as a link (research r2, mobile-06): "Unlock it
 * with Unlock PDF first". The link takes the file along when this screen has one (`file`, or the
 * file its drop zone last took), so Unlock PDF opens with it. A locked-file message that does not
 * name the tool exactly (Compress's "Unlock it first", some languages) gets the link after it.
 */
export const ErrorText: React.FC<{ text: string; file?: File | null }> = ({ text, file }) => {
  useI18n();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { setOpenedPdfFile } = useOpenedPdf();
  for (const step of NEXT_STEPS) {
    if (pathname === step.to) continue;
    const name = step.name();
    const at = text.indexOf(name);
    const after = at < 0 && step.keys.some((key) => text === t(key, {}));
    if (at < 0 && !after) continue;
    const handOn = file ?? pickedFileOn(pathname);
    const link = (
      <Link
        to={step.to}
        className="tk-drop-error-link"
        onClick={handOn ? (event) => {
          event.preventDefault();
          const opened = setOpenedPdfFile(handOn);
          navigate(step.to, { state: { useOpenedPdf: true, openedPdfId: opened.id } });
        } : undefined}
      >{name}</Link>
    );
    if (after) return <>{text} {link}</>;
    return <>{text.slice(0, at)}{link}{text.slice(at + name.length)}</>;
  }
  return <>{text}</>;
};
