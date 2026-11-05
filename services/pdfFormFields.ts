/** Read a PDF's AcroForm widgets through PDF.js into fields the editor can draw and fill. */

export type PdfFormFieldKind = 'text' | 'textarea' | 'checkbox' | 'radio' | 'select' | 'multiselect';
export type PdfFormFieldValue = string | boolean | string[];

export interface PdfFormFieldOption {
  label: string;
  value: string;
}

export interface PdfFormFieldDefinition {
  id: string;
  fieldName: string;
  label: string;
  kind: PdfFormFieldKind;
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  readOnly: boolean;
  required: boolean;
  value: PdfFormFieldValue;
  options?: PdfFormFieldOption[];
  radioValue?: string;
}

const prettifyFieldName = (fieldName: string) =>
  fieldName
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());

const normalizePdfFieldValue = (annotation: any): PdfFormFieldValue => {
  if (annotation.fieldType === 'Btn' && annotation.checkBox) {
    return Boolean(annotation.fieldValue && annotation.fieldValue !== 'Off');
  }

  // "Off" is how a PDF says no option is chosen. It is not an option, and selecting it on save fails.
  if (annotation.fieldType === 'Btn' && annotation.radioButton) {
    return typeof annotation.fieldValue === 'string' && annotation.fieldValue !== 'Off' ? annotation.fieldValue : '';
  }

  if (annotation.fieldType === 'Ch') {
    if (annotation.multiSelect) {
      return Array.isArray(annotation.fieldValue)
        ? annotation.fieldValue.filter((value: unknown): value is string => typeof value === 'string')
        : typeof annotation.fieldValue === 'string' && annotation.fieldValue
          ? [annotation.fieldValue]
          : [];
    }

    if (Array.isArray(annotation.fieldValue)) {
      return typeof annotation.fieldValue[0] === 'string' ? annotation.fieldValue[0] : '';
    }

    return typeof annotation.fieldValue === 'string' ? annotation.fieldValue : '';
  }

  return typeof annotation.fieldValue === 'string' ? annotation.fieldValue : '';
};

export const getPdfFormFields = async (pdfDoc: any): Promise<PdfFormFieldDefinition[]> => {
  const fields: PdfFormFieldDefinition[] = [];

  for (let pageIndex = 0; pageIndex < (pdfDoc?.numPages || 0); pageIndex += 1) {
    const page = await pdfDoc.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 1 });
    const annotations = await page.getAnnotations();

    annotations.forEach((annotation: any) => {
      if (!annotation?.fieldName || annotation.hidden || annotation.noHTML || annotation.pushButton) {
        return;
      }

      const rect = Array.isArray(annotation.rect) ? annotation.rect : null;
      if (!rect || rect.length < 4) return;

      const left = Math.min(rect[0], rect[2]);
      const right = Math.max(rect[0], rect[2]);
      const bottom = Math.min(rect[1], rect[3]);
      const top = Math.max(rect[1], rect[3]);
      const width = Math.max(1, right - left);
      const height = Math.max(1, top - bottom);
      const y = Math.max(0, viewport.height - top);

      let kind: PdfFormFieldKind | null = null;
      if (annotation.fieldType === 'Tx') {
        kind = annotation.multiLine ? 'textarea' : 'text';
      } else if (annotation.fieldType === 'Btn' && annotation.checkBox) {
        kind = 'checkbox';
      } else if (annotation.fieldType === 'Btn' && annotation.radioButton) {
        kind = 'radio';
      } else if (annotation.fieldType === 'Ch') {
        kind = annotation.multiSelect ? 'multiselect' : 'select';
      }

      if (!kind) return;

      const options = Array.isArray(annotation.options)
        ? annotation.options
            .map((option: any) => {
              const value = typeof option?.exportValue === 'string' ? option.exportValue : '';
              const label = typeof option?.displayValue === 'string' && option.displayValue
                ? option.displayValue
                : value;
              return value ? { label, value } : null;
            })
            .filter((option: PdfFormFieldOption | null): option is PdfFormFieldOption => Boolean(option))
        : undefined;

      fields.push({
        id: String(annotation.id || `${annotation.fieldName}-${pageIndex}-${fields.length}`),
        fieldName: annotation.fieldName,
        label: annotation.alternativeText || prettifyFieldName(annotation.fieldName),
        kind,
        pageIndex,
        x: left,
        y,
        width,
        height,
        readOnly: Boolean(annotation.readOnly),
        required: Boolean(annotation.required),
        value: normalizePdfFieldValue(annotation),
        options,
        // PDF.js puts a radio widget's own value in buttonValue; exportValue is the checkbox's.
        radioValue: typeof annotation.buttonValue === 'string' ? annotation.buttonValue : undefined,
      });
    });
  }

  return fields;
};
