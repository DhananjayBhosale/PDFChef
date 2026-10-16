import { localizeError } from '../../services/i18n/errors.ts';
import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useState, useEffect } from 'react';
import { FileUpload } from '../UI/FileUpload';
import { PDFLoadingProgress } from '../UI/PDFLoadingProgress';
import { PDFFile, ProcessingStatus } from '../../types';
import { getPdfPagePreviews, type PdfPreviewProgress } from '../../services/pdfBrowser';
import { rotateSpecificPages } from '../../services/pdfDocument';
import { downloadBlob, isPdfFile, revokeObjectUrls } from '../../services/pdfShared';
import { RotateCw, Undo2, Save } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { v4 as uuidv4 } from 'uuid';
import { PageThumbnail } from '../UI/PageThumbnail';
import { StatusToast } from '../UI/StatusToast';
import { Button } from '../UI/Primitives';
import { ToolChoiceRow, ToolHeader, ToolPanel, ToolSelectionBar, ToolShell } from '../UI/ToolLayout';
import { sanitizePageRotationDegrees } from '../../services/androidParity';
import { toolOutputName } from '../UI/format';

export const RotatePDF: React.FC = () => {
  useI18n();
  const [file, setFile] = useState<PDFFile | null>(null);
  const [previews, setPreviews] = useState<string[]>([]);
  const [loadingPreviews, setLoadingPreviews] = useState(false);
  const [previewProgress, setPreviewProgress] = useState<PdfPreviewProgress | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [selectedPages, setSelectedPages] = useState<number[]>([]);
  const [pageRotations, setPageRotations] = useState<Record<number, number>>({}); // Map pageIndex -> rotation
  const [selectionMessage, setSelectionMessage] = useState<string | null>(null);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  const totalPages = previews.length || file?.pageCount || 0;
  const rotationArray = (Object.entries(pageRotations) as Array<[string, number]>)
    .filter(([_, rotation]) => sanitizePageRotationDegrees(rotation) !== 0)
    .map(([pageIndex, rotation]) => ({ pageIndex: Number(pageIndex), rotation: sanitizePageRotationDegrees(rotation) }));
  const hasRotationChanges = rotationArray.length > 0;

  // Load previews
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setPreviewProgress(null);

    if (file) {
      setLoadingPreviews(true);
      setPreviewError(null);
      getPdfPagePreviews(file.file, {
        signal: controller.signal,
        onProgress: (progress) => { if (!cancelled) setPreviewProgress(progress); },
      })
        .then(urls => {
          if (cancelled) {
            revokeObjectUrls(urls);
            return;
          }
          setPreviews(urls);
          setLoadingPreviews(false);
          // Initialize rotations to 0
          const initialRotations: Record<number, number> = {};
          for (let i = 0; i < urls.length; i += 1) initialRotations[i] = 0;
          setPageRotations(initialRotations);
          setSelectedPages(Array.from({ length: urls.length }, (_, index) => index));
          setSelectionMessage(null);
        })
        .catch(err => {
          if (cancelled) return;
          console.error(err);
          setPreviewError(err instanceof Error ? localizeError(err) : t("rotate-pdf.the.pages.could.not.be.shown.choose.9884e4"));
          setLoadingPreviews(false);
        });
    } else {
      setPreviews([]);
      setPageRotations({});
      setSelectedPages([]);
      setSelectionMessage(null);
      setPreviewError(null);
    }

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [file]);

  useEffect(() => {
    return () => {
      revokeObjectUrls(previews);
    };
  }, [previews]);

  const handleFilesSelected = (files: File[]) => {
    if (files.length === 0) return;
    const f = files[0];
    if (!isPdfFile(f)) return;

    setFile({
      id: uuidv4(),
      file: f,
      name: f.name,
      size: f.size,
    });
  };

  const togglePage = (index: number) => {
    setSelectionMessage(null);
    setSelectedPages(prev => 
      prev.includes(index) ? prev.filter(i => i !== index) : [...prev, index]
    );
  };

  const rotateSelected = (angle: 90 | -90) => {
    if (selectedPages.length === 0) {
      setSelectionMessage(t("rotate-pdf.select.at.least.one.page.to.rotate.0729e0"));
      return;
    }
    const next = { ...pageRotations };
    selectedPages.forEach(index => {
      next[index] = sanitizePageRotationDegrees((next[index] || 0) + angle);
    });
    setPageRotations(next);
    // Say how the selected pages now face, not what this tap did: two right turns
    // are 180°, and right then left is upright again. Upright, upside down or a
    // mix has no 90° turn to name, so the line goes back to the selection count.
    const turns = new Set(selectedPages.map(index => next[index]));
    const turn = turns.size === 1 ? [...turns][0] : 0;
    setSelectionMessage(
      turn === 90 || turn === -90
        ? t(turn < 0 ? 'rotate.turned.left' : 'rotate.turned.right', { count: selectedPages.length })
        : null,
    );
  };

  const resetRotation = () => {
    const next: Record<number, number> = {};
    for (let i = 0; i < totalPages; i += 1) next[i] = 0;
    setPageRotations(next);
    setSelectionMessage(t("rotate-pdf.all.rotation.changes.reset.6ccc9a"));
  };

  const handleSave = async () => {
    if (!file) return;
    setStatus({ isProcessing: true, progress: 10, message: t("rotate-pdf.applying.rotations.dbe0c1") });
    
    try {
      if (rotationArray.length === 0) {
        setStatus({ isProcessing: false, progress: 0, message: '', error: t("rotate-pdf.select.at.least.one.page.and.a.18a7e9") });
        return;
      }

      const pdfBytes = await rotateSpecificPages(file.file, rotationArray, (current, total) => {
        setStatus({
          isProcessing: true,
          progress: Math.round((current / Math.max(1, total)) * 100),
          message: t("rotate-pdf.rotating.page.of.c99b01", { v0: current, v1: total }),
        });
      });
      
      downloadBlob(
        new Blob([pdfBytes], { type: 'application/pdf' }),
        toolOutputName('rotate', file.name, 'pdf'),
      );
      setStatus({ isProcessing: false, progress: 100, message: t("rotate-pdf.rotated.pdf.ready.d9ab7a") });
    } catch (error) {
      console.error(error);
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: error instanceof Error ? localizeError(error) : t("rotate-pdf.rotation.failed.7a64b8"),
      });
    }
  };

  return (
    <ToolShell width="full" centered={!file}>
      <ToolHeader title={t("rotate-pdf.rotate.pages.0cbe65")} />

      <AnimatePresence mode="wait">
        {!file ? (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="max-w-3xl mx-auto">
             <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label={t("rotate-pdf.choose.a.pdf.to.rotate.123e33")} />
          </motion.div>
        ) : (
          <motion.div
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex flex-col gap-3"
          >
            {/* Source, rotation, selection: one surface, because they are one
                decision. The pair of turn actions used to be two large padded
                boxes and the instruction under them repeated what the thumbnails
                and the button labels already say. */}
            <ToolPanel className="flex flex-col gap-2.5">
              <div className="flex items-center gap-2 min-w-0">
                <button
                  onClick={() => setFile(null)}
                  className="chef-pressable chef-target -ml-1 flex shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)]"
                  aria-label={t("rotate-pdf.choose.another.pdf.9434e3")}
                >
                  <Undo2 aria-hidden size={18} />
                </button>
                <h2 className="chef-filename min-w-0 flex-1 text-sm font-semibold text-[var(--text-primary)]">{file.name}</h2>
              </div>

              <ToolChoiceRow
                label={t("rotate-pdf.rotation.57b5e2")}
                choices={[
                  {
                    key: 'left',
                    label: t("rotate-pdf.left.90.4b87de"),
                    // The accessible name starts with the visible label, so "Left 90°" spoken
                    // and "Left 90°" seen are the same control (WCAG 2.5.3).
                    ariaLabel: t("rotate-pdf.left.90.rotate.selected.pages.counterclockwise.0fd123"),
                    icon: <RotateCw aria-hidden size={18} className="-scale-x-100 shrink-0" />,
                    onClick: () => rotateSelected(-90),
                    disabled: selectedPages.length === 0,
                  },
                  {
                    key: 'right',
                    label: t("rotate-pdf.right.90.471b9b"),
                    ariaLabel: t("rotate-pdf.right.90.rotate.selected.pages.clockwise.a6de0a"),
                    icon: <RotateCw aria-hidden size={18} className="shrink-0" />,
                    onClick: () => rotateSelected(90),
                    disabled: selectedPages.length === 0,
                  },
                ]}
              />

              <ToolSelectionBar
                summary={selectionMessage ?? t("rotate-pdf.of.selected.2d057c", { v0: selectedPages.length, v1: totalPages })}
                actions={[
                  {
                    key: 'select-all',
                    label: t("rotate-pdf.select.all.1fc9a3"),
                    disabled: totalPages === 0 || selectedPages.length === totalPages,
                    onClick: () => {
                      setSelectedPages(Array.from({ length: totalPages }, (_, index) => index));
                      setSelectionMessage(t("rotate-pdf.all.pages.selected.044753"));
                    },
                  },
                  {
                    key: 'clear',
                    label: t("rotate-pdf.clear.83b12c"),
                    disabled: selectedPages.length === 0 && !hasRotationChanges,
                    onClick: () => {
                      setSelectedPages([]);
                      resetRotation();
                      setSelectionMessage(t("rotate-pdf.selection.and.rotations.cleared.5f1e1a"));
                    },
                  },
                  // Reset only exists once there is something to undo. Greyed out
                  // it held a full row of its own above the page list.
                  { key: 'reset', label: t("rotate-pdf.reset.daee76"), hidden: !hasRotationChanges, onClick: resetRotation },
                ]}
              />
            </ToolPanel>
            {loadingPreviews && <PDFLoadingProgress progress={previewProgress} />}

            {/* In flow, directly under the choice it acts on. The floating bar
                this replaces sat over the tab bar and needed a 96px spacer
                below the pages to clear itself. */}
            <Button
              tone="primary"
              block
              busy={status.isProcessing}
              disabled={!hasRotationChanges}
              icon={<Save aria-hidden size={18} />}
              onClick={() => void handleSave()}
            >
              {status.isProcessing ? status.message || t("rotate-pdf.rotating.pages.a6d7f2") : t("rotate-pdf.save.turned.pdf.fa1cfd")}
            </Button>

            {loadingPreviews ? null : previewError ? (
              <div className="flex flex-col items-center gap-2 rounded-[var(--radius-panel)] border border-[var(--border-hairline)] px-4 py-4 text-center">
                <p className="font-semibold text-[var(--status-danger-text)]">{t("rotate-pdf.the.pages.could.not.be.shown.choose.9884e4")}</p>
                <p className="max-w-measure text-sm text-[var(--text-secondary)]">{previewError}</p>
                <Button tone="secondary" onClick={() => setFile(null)}>{t("rotate-pdf.choose.another.pdf.9434e3")}</Button>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-4 md:grid-cols-4 lg:grid-cols-5">
                {previews.map((url, index) => (
                  <PageThumbnail
                    key={index}
                    pageIndex={index}
                    imageUrl={url}
                    isSelected={selectedPages.includes(index)}
                    onToggle={() => togglePage(index)}
                    rotation={pageRotations[index] || 0}
                  />
                ))}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
      <StatusToast status={status} />
    </ToolShell>
  );
};
