import { t } from '../services/i18n/core.ts';
import { useI18n } from '../services/i18n/react';
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { v4 as uuidv4 } from 'uuid';
import type { PDFFile } from '../types';

interface OpenedPdfContextValue {
  openedPdf: PDFFile | null;
  setOpenedPdfFile: (file: File, options?: { provenance?: PDFFile['provenance']; previewOnly?: boolean }) => PDFFile;
  stageProtectedPdfPassword: (openedPdfId: string, password: string) => void;
  takeProtectedPdfPassword: (openedPdfId: string) => string | null;
  clearOpenedPdf: () => void;
}

export interface OpenedPdfRouteState {
  useOpenedPdf?: boolean;
  openedPdfId?: string;
}

const OpenedPdfContext = createContext<OpenedPdfContextValue | null>(null);

const isPdfFile = (file: File) =>
  file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

export const OpenedPdfProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  useI18n();
  const [openedPdf, setOpenedPdf] = useState<PDFFile | null>(null);
  const protectedPasswordHandoffRef = useRef<{ openedPdfId: string; password: string } | null>(null);
  const navigate = useNavigate();

  const setOpenedPdfFile = (
    file: File,
    options: { provenance?: PDFFile['provenance']; previewOnly?: boolean } = {},
  ) => {
    const nextPdf: PDFFile = {
      id: uuidv4(),
      file,
      name: file.name,
      size: file.size,
      provenance: options.provenance ?? (options.previewOnly ? 'preview' : 'imported'),
      previewOnly: options.previewOnly ?? options.provenance === 'preview',
    };

    protectedPasswordHandoffRef.current = null;
    setOpenedPdf(nextPdf);
    return nextPdf;
  };

  // A verified password is staged only for the next in-app tool handoff. It is
  // never written to route/history state, storage, logs, or a rendered value.
  const stageProtectedPdfPassword = (openedPdfId: string, password: string) => {
    if (openedPdf?.id !== openedPdfId || password.length === 0) return;
    protectedPasswordHandoffRef.current = { openedPdfId, password };
  };

  const takeProtectedPdfPassword = (openedPdfId: string) => {
    const handoff = protectedPasswordHandoffRef.current;
    if (!handoff || handoff.openedPdfId !== openedPdfId) return null;
    protectedPasswordHandoffRef.current = null;
    return handoff.password;
  };

  useEffect(() => {
    const launchQueue = (window as any).launchQueue;
    if (!launchQueue?.setConsumer) return;

    launchQueue.setConsumer(async (launchParams: any) => {
      const handle = launchParams?.files?.[0];
      if (!handle?.getFile) return;

      const file = await handle.getFile();
      if (!isPdfFile(file)) return;

      setOpenedPdfFile(file);
      navigate('/view');
    });
  }, [navigate]);

  const value = useMemo<OpenedPdfContextValue>(
    () => ({
      openedPdf,
      setOpenedPdfFile,
      stageProtectedPdfPassword,
      takeProtectedPdfPassword,
      clearOpenedPdf: () => {
        protectedPasswordHandoffRef.current = null;
        setOpenedPdf(null);
      },
    }),
    [openedPdf],
  );

  return <OpenedPdfContext.Provider value={value}>{children}</OpenedPdfContext.Provider>;
};

export const useOpenedPdf = () => {
  const context = useContext(OpenedPdfContext);
  if (!context) {
    throw new Error(t("use-opened-pdf.useopenedpdf.must.be.used.inside.openedpdfprovider.4b1a84"));
  }
  return context;
};
