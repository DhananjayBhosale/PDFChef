import React, { useState, useEffect } from 'react';
import { FileUpload } from '../UI/FileUpload';
import { PDFFile, ProcessingStatus } from '../../types';
import { getPdfPagePreviews } from '../../services/pdfBrowser';
import { rotateSpecificPages } from '../../services/pdfDocument';
import { downloadBlob, isPdfFile, revokeObjectUrls } from '../../services/pdfShared';
import { RotateCw, Loader2, Undo2, Save } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { v4 as uuidv4 } from 'uuid';
import { PageThumbnail } from '../UI/PageThumbnail';
import { StatusToast } from '../UI/StatusToast';
import { Button } from '../UI/Primitives';
import { ToolChoiceRow, ToolHeader, ToolPanel, ToolSelectionBar, ToolShell } from '../UI/ToolLayout';
import { androidExportFileName, sanitizePageRotationDegrees } from '../../services/androidParity';

export const RotatePDF: React.FC = () => {
  const [file, setFile] = useState<PDFFile | null>(null);
  const [previews, setPreviews] = useState<string[]>([]);
  const [loadingPreviews, setLoadingPreviews] = useState(false);
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

    if (file) {
      setLoadingPreviews(true);
      setPreviewError(null);
      getPdfPagePreviews(file.file)
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
          setPreviewError(err instanceof Error ? err.message : 'The pages could not be shown. Choose another file, or run Repair PDF on it first.');
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
      setSelectionMessage('Select at least one page to rotate.');
      return;
    }
    setPageRotations(prev => {
      const next = { ...prev };
      selectedPages.forEach(index => {
        next[index] = sanitizePageRotationDegrees((next[index] || 0) + angle);
      });
      return next;
    });
    setSelectionMessage(`${selectedPages.length} page${selectedPages.length === 1 ? '' : 's'} turned ${angle < 0 ? 'left' : 'right'} 90°.`);
  };

  const resetRotation = () => {
    const next: Record<number, number> = {};
    for (let i = 0; i < totalPages; i += 1) next[i] = 0;
    setPageRotations(next);
    setSelectionMessage('All rotation changes reset.');
  };

  const handleSave = async () => {
    if (!file) return;
    setStatus({ isProcessing: true, progress: 10, message: 'Applying rotations...' });
    
    try {
      if (rotationArray.length === 0) {
        setStatus({ isProcessing: false, progress: 0, message: '', error: 'Select at least one page and a rotation before exporting.' });
        return;
      }

      const pdfBytes = await rotateSpecificPages(file.file, rotationArray, (current, total) => {
        setStatus({
          isProcessing: true,
          progress: Math.round((current / Math.max(1, total)) * 100),
          message: `Rotating page ${current} of ${total}...`,
        });
      });
      
      downloadBlob(
        new Blob([pdfBytes], { type: 'application/pdf' }),
        androidExportFileName('rotate_pages', file.name, 'pdf'),
      );
      setStatus({ isProcessing: false, progress: 100, message: 'Rotated PDF ready.' });
    } catch (error) {
      console.error(error);
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: error instanceof Error ? error.message : 'Rotation failed.',
      });
    }
  };

  return (
    <ToolShell width="full" centered={!file}>
      <ToolHeader title="Rotate Pages" />

      <AnimatePresence mode="wait">
        {!file ? (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="max-w-3xl mx-auto">
             <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label="Choose a PDF to rotate" />
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
                  aria-label="Choose another PDF"
                >
                  <Undo2 aria-hidden size={18} />
                </button>
                <h2 className="chef-filename min-w-0 flex-1 text-sm font-semibold text-[var(--text-primary)]">{file.name}</h2>
              </div>

              <ToolChoiceRow
                label="Rotation"
                choices={[
                  {
                    key: 'left',
                    label: 'Left 90°',
                    // The accessible name starts with the visible label, so "Left 90°" spoken
                    // and "Left 90°" seen are the same control (WCAG 2.5.3).
                    ariaLabel: 'Left 90°, rotate selected pages counterclockwise',
                    icon: <RotateCw aria-hidden size={18} className="-scale-x-100 shrink-0" />,
                    onClick: () => rotateSelected(-90),
                    disabled: selectedPages.length === 0,
                  },
                  {
                    key: 'right',
                    label: 'Right 90°',
                    ariaLabel: 'Right 90°, rotate selected pages clockwise',
                    icon: <RotateCw aria-hidden size={18} className="shrink-0" />,
                    onClick: () => rotateSelected(90),
                    disabled: selectedPages.length === 0,
                  },
                ]}
              />

              <ToolSelectionBar
                summary={selectionMessage ?? `${selectedPages.length} of ${totalPages} selected`}
                actions={[
                  {
                    key: 'select-all',
                    label: 'Select all',
                    disabled: totalPages === 0 || selectedPages.length === totalPages,
                    onClick: () => {
                      setSelectedPages(Array.from({ length: totalPages }, (_, index) => index));
                      setSelectionMessage('All pages selected.');
                    },
                  },
                  {
                    key: 'clear',
                    label: 'Clear',
                    disabled: selectedPages.length === 0 && !hasRotationChanges,
                    onClick: () => {
                      setSelectedPages([]);
                      resetRotation();
                      setSelectionMessage('Selection and rotations cleared.');
                    },
                  },
                  // Reset only exists once there is something to undo. Greyed out
                  // it held a full row of its own above the page list.
                  { key: 'reset', label: 'Reset', hidden: !hasRotationChanges, onClick: resetRotation },
                ]}
              />
            </ToolPanel>

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
              {status.isProcessing ? status.message || 'Rotating pages...' : 'Save turned PDF'}
            </Button>

            {loadingPreviews ? (
              <div className="flex flex-col items-center justify-center gap-2 py-6 text-[var(--text-tertiary)]">
                <Loader2 aria-hidden className="animate-spin" size={24} />
                <p className="text-sm">Loading pages...</p>
              </div>
            ) : previewError ? (
              <div className="flex flex-col items-center gap-2 rounded-[var(--radius-panel)] border border-[var(--border-hairline)] px-4 py-4 text-center">
                <p className="font-semibold text-[var(--status-danger-text)]">The pages could not be shown. Choose another file, or run Repair PDF on it first.</p>
                <p className="max-w-measure text-sm text-[var(--text-secondary)]">{previewError}</p>
                <Button tone="secondary" onClick={() => setFile(null)}>Choose another PDF</Button>
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
