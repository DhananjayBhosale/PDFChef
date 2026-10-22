import { t } from './services/i18n/core';
import { useI18n } from './services/i18n/react';
import React, { Suspense, useEffect, useMemo, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { createBrowserRouter, RouterProvider, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { AppShell } from './components/Layout/AppShell';
import { NativeBackHandler } from './components/Layout/NativeBackHandler';
import { AndroidIncomingPdfHandler } from './components/Layout/AndroidIncomingPdfHandler';
import { RendererRecoveryNotice } from './components/Layout/RendererRecoveryNotice';
import { IosIncomingPdfHandler } from './components/Layout/IosIncomingPdfHandler';
import { Dashboard } from './components/Tools/Dashboard';
import { RouteSEO } from './components/SEO/RouteSEO';
import { OpenedPdfProvider } from './hooks/useOpenedPdf';
import { FileDropProvider } from './hooks/useFileDrop';
import { MonetizationProvider } from './hooks/useMonetization';
import { SupportProvider } from './hooks/useSupport';
import { AppearanceProvider } from './hooks/useAppearance';
import { WorkspacePlatformProvider, type WorkspacePlatform } from './hooks/useWorkspaceRuntime';
import { OutputCenter } from './components/UI/OutputCenter';
import { ProPaywall } from './components/UI/ProPaywall';
import { SupportPrompt } from './components/UI/SupportPDFChef';
import { Onboarding } from './components/UI/Onboarding';
import { MobileAppWelcome } from './components/UI/MobileAppWelcome';
import { isMobileAppWelcomeRoute, mobileAppWelcomeDismissedKey, smartphonePlatform } from './services/mobileAppWelcome';
import { getWorkspaceSettings, rememberToolUse } from './services/workspace';

const MergePDF = React.lazy(() => import('./components/Tools/MergePDF').then((module) => ({ default: module.MergePDF })));
const ViewPDF = React.lazy(() => import('./components/Tools/ViewPDF').then((module) => ({ default: module.ViewPDF })));
const ImageToPDF = React.lazy(() => import('./components/Tools/ImageToPDF').then((module) => ({ default: module.ImageToPDF })));
const SplitPDF = React.lazy(() => import('./components/Tools/SplitPDF').then((module) => ({ default: module.SplitPDF })));
const RotatePDF = React.lazy(() => import('./components/Tools/RotatePDF').then((module) => ({ default: module.RotatePDF })));
const CompressPDF = React.lazy(() => import('./components/Tools/CompressPDF').then((module) => ({ default: module.CompressPDF })));
const SecurityPDF = React.lazy(() => import('./components/Tools/SecurityPDF').then((module) => ({ default: module.SecurityPDF })));
const MetadataPDF = React.lazy(() => import('./components/Tools/MetadataPDF').then((module) => ({ default: module.MetadataPDF })));
const ReorderPDF = React.lazy(() => import('./components/Tools/ReorderPDF').then((module) => ({ default: module.ReorderPDF })));
const DeletePages = React.lazy(() => import('./components/Tools/DeletePages').then((module) => ({ default: module.DeletePages })));
const ExtractPages = React.lazy(() => import('./components/Tools/ExtractPages').then((module) => ({ default: module.ExtractPages })));
const PDFToImage = React.lazy(() => import('./components/Tools/PDFToImage').then((module) => ({ default: module.PDFToImage })));
const UnlockPDF = React.lazy(() => import('./components/Tools/UnlockPDF').then((module) => ({ default: module.UnlockPDF })));
const FlattenPDF = React.lazy(() => import('./components/Tools/FlattenPDF').then((module) => ({ default: module.FlattenPDF })));
const OCRPDF = React.lazy(() => import('./components/Tools/OCRPDF').then((module) => ({ default: module.OCRPDF })));
const EditPDF = React.lazy(() => import('./components/Tools/EditPDF').then((module) => ({ default: module.EditPDF })));
const SignPDF = React.lazy(() => import('./components/Tools/SignPDF').then((module) => ({ default: module.SignPDF })));
const VerifySignaturesPDF = React.lazy(() => import('./components/Tools/VerifySignaturesPDF').then((module) => ({ default: module.VerifySignaturesPDF })));
const ComparePDF = React.lazy(() => import('./components/Tools/ComparePDF').then((module) => ({ default: module.ComparePDF })));
const WatermarkPDF = React.lazy(() => import('./components/Tools/WatermarkPDF').then((module) => ({ default: module.WatermarkPDF })));
const PageNumbersPDF = React.lazy(() => import('./components/Tools/PageNumbersPDF').then((module) => ({ default: module.PageNumbersPDF })));
const RepairPDF = React.lazy(() => import('./components/Tools/RepairPDF').then((module) => ({ default: module.RepairPDF })));
const MakePDF = React.lazy(() => import('./components/Tools/MakePDF').then((module) => ({ default: module.MakePDF })));
const PDFToWord = React.lazy(() => import('./components/Tools/PDFToWord').then((module) => ({ default: module.PDFToWord })));
const MakeFillable = React.lazy(() => import('./components/Tools/MakeFillable').then((module) => ({ default: module.MakeFillable })));
const WordToPDF = React.lazy(() => import('./components/Tools/WordToPDF').then((module) => ({ default: module.WordToPDF })));
const PowerPointToPDF = React.lazy(() => import('./components/Tools/PowerPointToPDF').then((module) => ({ default: module.PowerPointToPDF })));
const BatchPDF = React.lazy(() => import('./components/Tools/BatchPDF').then((module) => ({ default: module.BatchPDF })));
const CreateInvoice = React.lazy(() => import('./components/Tools/BusinessDocumentBuilder').then((module) => ({ default: module.CreateInvoice })));
const CreateReceipt = React.lazy(() => import('./components/Tools/BusinessDocumentBuilder').then((module) => ({ default: module.CreateReceipt })));
const CreateQuote = React.lazy(() => import('./components/Tools/BusinessDocumentBuilder').then((module) => ({ default: module.CreateQuote })));
const CropPDF = React.lazy(() => import('./components/Tools/PdfAdvancedTools').then((module) => ({ default: module.CropPDF })));
const HeaderFooterPDF = React.lazy(() => import('./components/Tools/PdfAdvancedTools').then((module) => ({ default: module.HeaderFooterPDF })));
const RemoveMetadataPDF = React.lazy(() => import('./components/Tools/PdfAdvancedTools').then((module) => ({ default: module.RemoveMetadataPDF })));
const RemoveAnnotationsPDF = React.lazy(() => import('./components/Tools/PdfAdvancedTools').then((module) => ({ default: module.RemoveAnnotationsPDF })));
const RemoveBlankPagesPDF = React.lazy(() => import('./components/Tools/PdfAdvancedTools').then((module) => ({ default: module.RemoveBlankPagesPDF })));
const ExtractImagesPDF = React.lazy(() => import('./components/Tools/PdfAdvancedTools').then((module) => ({ default: module.ExtractImagesPDF })));
const SanitizePDF = React.lazy(() => import('./components/Tools/PdfAdvancedTools').then((module) => ({ default: module.SanitizePDF })));
const PrivacyPolicy = React.lazy(() => import('./components/Pages/PrivacyPolicy').then((module) => ({ default: module.PrivacyPolicy })));
const PdfChefPrivacy = React.lazy(() => import('./components/Pages/PdfChefPrivacy').then((module) => ({ default: module.PdfChefPrivacy })));
const TermsConditions = React.lazy(() => import('./components/Pages/TermsConditions').then((module) => ({ default: module.TermsConditions })));
const RecentPage = React.lazy(() => import('./components/Pages/RecentPage').then((module) => ({ default: module.RecentPage })));
const SettingsPage = React.lazy(() => import('./components/Pages/SettingsPage').then((module) => ({ default: module.SettingsPage })));
const HelpPage = React.lazy(() => import('./components/Pages/HelpPage').then((module) => ({ default: module.HelpPage })));
const OpenSourceLicenses = React.lazy(() => import('./components/Pages/OpenSourceLicenses').then((module) => ({ default: module.OpenSourceLicenses })));

const PageLoader = () => { useI18n(); return (
  <div role="status" aria-live="polite" aria-busy="true" className="mx-auto w-full max-w-4xl px-4 py-6 md:px-8">
    <span className="sr-only">{t("app.opening.the.tool.51992c")}</span>
    <div aria-hidden className="space-y-3">
      <div className="h-7 w-1/2 rounded-[var(--radius-control)] bg-[var(--surface-sunken)]" />
      <div className="h-4 w-3/4 rounded-[var(--radius-pill)] bg-[var(--surface-sunken)]" />
      <div className="h-40 rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-sunken)]" />
    </div>
  </div>
); };

const AppRoutes = () => {
  const location = useLocation();

  return (
    <div key={location.pathname} className="chef-enter flex-1">
        <Suspense fallback={<PageLoader />}>
          <Routes location={location}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/view" element={<ViewPDF />} />
            <Route path="/compress" element={<CompressPDF />} />
            <Route path="/merge" element={<MergePDF />} />
            <Route path="/split" element={<SplitPDF />} />
            <Route path="/edit" element={<EditPDF />} />
            <Route path="/pdf-to-jpg" element={<PDFToImage />} />
            <Route path="/pdf-to-word" element={<PDFToWord />} />
            <Route path="/word-to-pdf" element={<WordToPDF />} />
            <Route path="/powerpoint-to-pdf" element={<PowerPointToPDF />} />
            <Route path="/image-to-pdf" element={<ImageToPDF />} />
            <Route path="/make-pdf" element={<MakePDF />} />
            <Route path="/make-fillable" element={<MakeFillable />} />
            <Route path="/sign" element={<SignPDF />} />
            <Route path="/verify-signatures" element={<VerifySignaturesPDF />} />
            <Route path="/delete-pages" element={<DeletePages />} />
            <Route path="/reorder" element={<ReorderPDF />} />
            <Route path="/rotate" element={<RotatePDF />} />
            <Route path="/protect" element={<SecurityPDF />} />
            <Route path="/unlock" element={<UnlockPDF />} />
            <Route path="/extract" element={<ExtractPages />} />
            <Route path="/metadata" element={<MetadataPDF />} />
            <Route path="/flatten" element={<FlattenPDF />} />
            <Route path="/compare" element={<ComparePDF />} />
            <Route path="/ocr" element={<OCRPDF />} />
            <Route path="/watermark" element={<WatermarkPDF />} />
            <Route path="/page-numbers" element={<PageNumbersPDF />} />
            <Route path="/repair" element={<RepairPDF />} />
            <Route path="/crop" element={<CropPDF />} />
            <Route path="/header-footer" element={<HeaderFooterPDF />} />
            <Route path="/remove-metadata" element={<RemoveMetadataPDF />} />
            <Route path="/remove-annotations" element={<RemoveAnnotationsPDF />} />
            <Route path="/remove-blank-pages" element={<RemoveBlankPagesPDF />} />
            <Route path="/extract-images" element={<ExtractImagesPDF />} />
            <Route path="/sanitize" element={<SanitizePDF />} />
            <Route path="/batch" element={<BatchPDF />} />
            <Route path="/invoice" element={<CreateInvoice />} />
            <Route path="/receipt" element={<CreateReceipt />} />
            <Route path="/quote" element={<CreateQuote />} />
            <Route path="/recent" element={<RecentPage />} />
            {/* The pre-tab route stays live so an existing bookmark or deep link
                still lands on the same screen. */}
            <Route path="/history" element={<RecentPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/help" element={<HelpPage />} />
            <Route path="/privacy" element={<PrivacyPolicy />} />
            <Route path="/terms" element={<TermsConditions />} />
            <Route path="/licenses" element={<OpenSourceLicenses />} />
            <Route path="/privacy-policy" element={<PrivacyPolicy />} />
            <Route path="/pdf-chef-privacy" element={<PdfChefPrivacy />} />
            <Route path="/terms-and-conditions" element={<TermsConditions />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
    </div>
  );
};

const LegacyHashRedirect: React.FC = () => {
  const navigate = useNavigate();

  useEffect(() => {
    const hashPath = window.location.hash.replace(/^#/, '');
    if (hashPath.startsWith('/')) {
      navigate(hashPath, { replace: true });
    }
  }, [navigate]);

  return null;
};

const AppContent = () => {
  useI18n();
  const location = useLocation();
  const [welcomePlatform, setWelcomePlatform] = useState(() => {
    try {
      if (window.sessionStorage.getItem(mobileAppWelcomeDismissedKey) === 'true') return null;
    } catch { /* Continuing still works when browser storage is unavailable. */ }
    return smartphonePlatform(navigator.userAgent, Capacitor.getPlatform(), `${window.location.protocol}//${window.location.host}`);
  });
  const showMobileAppWelcome = welcomePlatform && isMobileAppWelcomeRoute(location.pathname);
  const continueToWebsite = () => {
    try { window.sessionStorage.setItem(mobileAppWelcomeDismissedKey, 'true'); } catch { /* Keep the in-memory choice. */ }
    setWelcomePlatform(null);
  };

  useEffect(() => {
    if (!showMobileAppWelcome) rememberToolUse(location.pathname);
  }, [location.pathname, showMobileAppWelcome]);

  useEffect(() => {
    const applyFont = () => {
      document.documentElement.dataset.interfaceFont = getWorkspaceSettings().interfaceFont;
    };
    applyFont();
    window.addEventListener('pdfchef:settings-changed', applyFont);
    return () => window.removeEventListener('pdfchef:settings-changed', applyFont);
  }, []);

  return (
    <>
      <RouteSEO />
      <LegacyHashRedirect />
      {showMobileAppWelcome ? (
        <MobileAppWelcome platform={welcomePlatform} onContinue={continueToWebsite} />
      ) : (
        <>
          <NativeBackHandler />
          <AndroidIncomingPdfHandler />
          <RendererRecoveryNotice />
          <IosIncomingPdfHandler />
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[200] focus:rounded-[var(--radius-control)] focus:bg-[var(--surface-raised)] focus:px-4 focus:py-2 focus:font-semibold"
          >{t("app.skip.to.content.ac576a")}</a>
          <AppShell>
            <AppRoutes />
          </AppShell>
          <OutputCenter />
          <ProPaywall />
          <SupportPrompt />
          <Onboarding />
        </>
      )}
    </>
  );
};

export interface AppRootProps {
  /**
   * The typed platform adapter. Omit it and the interface runs on the browser
   * fallback, which reports every capability it does not have rather than
   * pretending to have it.
   *
   * Codex injects the native adapter here and nothing visual changes:
   *
   * ```tsx
   * import { AppRoot } from './App';
   * root.render(<AppRoot platform={createIosPlatform()} />);
   * ```
   */
  platform?: WorkspacePlatform;
}

const AppProviders: React.FC<AppRootProps> = ({ platform }) => { return (
    <AppearanceProvider>
      <WorkspacePlatformProvider platform={platform}>
        <MonetizationProvider>
          <SupportProvider>
            <OpenedPdfProvider>
              <FileDropProvider>
                <AppContent />
              </FileDropProvider>
            </OpenedPdfProvider>
          </SupportProvider>
        </MonetizationProvider>
      </WorkspacePlatformProvider>
    </AppearanceProvider>
); };

/** The whole application, with the platform seam exposed. */
export const AppRoot: React.FC<AppRootProps> = ({ platform }) => {
  const router = useMemo(
    () => createBrowserRouter([{ path: '*', element: <AppProviders platform={platform} /> }]),
    [platform],
  );

  return <RouterProvider router={router} />;
};

/** Default entry point: browser fallback, no adapter injected. */
const App: React.FC = () => { return <AppRoot />; };

export default App;
