import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useEffect, useMemo, useRef, useState } from 'react';

export interface SelectableTextLine {
  id: string;
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize?: number;
}

interface SelectablePagePreviewProps {
  imageUrl: string | null;
  pageNumber: number;
  previewWidth: number;
  previewHeight: number;
  lines: SelectableTextLine[];
}

const FONT_FAMILY = 'Arial, Helvetica, sans-serif';
const measureCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
const measureContext = measureCanvas?.getContext('2d') ?? null;

const getLineFontSize = (line: SelectableTextLine) => Math.max(11, line.fontSize ?? line.height * 0.82);

const getScaleX = (text: string, fontSize: number, targetWidth: number) => {
  if (!measureContext || !text.trim() || targetWidth <= 0) return 1;
  measureContext.font = `${fontSize}px ${FONT_FAMILY}`;
  const measuredWidth = measureContext.measureText(text).width;
  if (!measuredWidth) return 1;
  return Math.min(6, Math.max(0.7, targetWidth / measuredWidth));
};

export const SelectablePagePreview: React.FC<SelectablePagePreviewProps> = ({
  imageUrl,
  pageNumber,
  previewWidth,
  previewHeight,
  lines,
}) => {
  useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const hasPreviewSize = previewWidth > 0 && previewHeight > 0;

  useEffect(() => {
    if (!hasPreviewSize) return;
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;

    const updateSize = () => {
      setContainerWidth(element.clientWidth);
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasPreviewSize]);

  const scale = previewWidth > 0 && containerWidth > 0 ? Math.min(1, containerWidth / previewWidth) : 1;
  const scaledWidth = Math.max(1, previewWidth * scale);
  const scaledHeight = Math.max(1, previewHeight * scale);

  const displayLines = useMemo(
    () =>
      lines.map((line) => {
        const fontSize = getLineFontSize(line);
        return {
          ...line,
          fontSize,
          scaleX: getScaleX(line.text, fontSize, line.width),
        };
      }),
    [lines],
  );

  if (!hasPreviewSize) {
    return (
      <div className="w-full rounded-[var(--radius-field)] border border-[var(--border-hairline)] bg-[var(--surface-sunken)] p-3 text-sm text-[var(--text-secondary)]">{t("selectable-page-preview.message.cb764d7bcb", { v0: pageNumber })}</div>
    );
  }

  return (
    <div className="w-full">
      <div className="mb-1.5 text-xs font-medium text-[var(--text-secondary)]">{t("selectable-page-preview.message.a09e9f528e", { v0: pageNumber })}</div>
      <div
        ref={containerRef}
        data-selectable-preview="true"
        className="w-full overflow-hidden rounded-[var(--radius-field)] border border-[var(--border-hairline)] bg-[var(--surface-sunken)]"
      >
        <div className="relative" style={{ width: scaledWidth, height: scaledHeight }}>
          <div
            className="absolute left-0 top-0 origin-top-left"
            style={{ width: previewWidth, height: previewHeight, transform: `scale(${scale})` }}
          >
            {imageUrl ? (
              <img
                src={imageUrl}
                alt={t("selectable-page-preview.page.preview.7f7e5e", { v0: pageNumber })}
                className="pointer-events-none absolute inset-0 h-full w-full select-none object-contain"
                draggable={false}
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-[var(--text-secondary)]">{t("selectable-page-preview.preview.unavailable.b99fa6")}</div>
            )}

            <div dir="ltr" className="absolute inset-0 cursor-text select-text">
              {displayLines.map((line) => (
                <div
                  key={line.id}
                  data-preview-line="true"
                  className="absolute select-text whitespace-pre text-transparent caret-transparent selection:bg-ink-400/30 selection:text-transparent"
                  style={{
                    left: line.left,
                    top: line.top,
                    width: Math.max(1, line.width),
                    minHeight: Math.max(1, line.height),
                    lineHeight: `${Math.max(1, line.height)}px`,
                    fontFamily: FONT_FAMILY,
                    fontSize: line.fontSize,
                    transform: `scaleX(${line.scaleX})`,
                    transformOrigin: 'top left',
                    WebkitTextFillColor: 'transparent',
                  }}
                >
                  {line.text}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
