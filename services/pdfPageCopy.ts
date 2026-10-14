import { LocalizedError } from './i18n/errors.ts';
import {
  PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFObjectCopier,
  PDFObject, PDFPage, PDFPageLeaf, PDFRef, PDFStream, PDFString,
} from 'pdf-lib';

const name = PDFName.of;
const textOf = (value: unknown) => value instanceof PDFString || value instanceof PDFHexString
  ? value.decodeText() : '';

const namesUnder = (field: PDFDict, prefix = '', visited = new Set<PDFDict>()): string[] => {
  if (visited.has(field)) return [];
  visited.add(field);
  const partial = textOf(field.lookup(name('T')));
  const full = [prefix, partial].filter(Boolean).join('.');
  const children = field.lookupMaybe(name('Kids'), PDFArray)?.asArray() ?? [];
  return children.length
    ? children.flatMap(reference => namesUnder(field.context.lookup(reference, PDFDict), full, visited))
    : full ? [full] : [];
};

/** Copy the page and its field tree with one reference map, including widget page pointers. */
export const copyPagesWithForms = async (
  destination: PDFDocument, source: PDFDocument, indices: number[],
): Promise<PDFPage[]> => {
  const sourceForm = source.catalog.lookupMaybe(name('AcroForm'), PDFDict);
  if (sourceForm?.has(name('XFA'))) {
    throw new LocalizedError("pdf-page-copy.this.pdf.uses.xfa.forms.export.a.f940e0");
  }

  await source.flush();
  const copier = PDFObjectCopier.for(source.context, destination.context);
  const pages = indices.map(index => {
    const reference = copier.copy(source.getPage(index).ref);
    const node = destination.context.lookup(reference);
    if (!(node instanceof PDFPageLeaf)) throw new LocalizedError("pdf-page-copy.a.selected.pdf.page.could.not.be.02cd4a");
    return PDFPage.of(node, reference, destination);
  });
  const retainedPageRefs = new Set(pages.map(page => page.ref));
  const namedDestinations = new Map<string, PDFObject>();
  const legacyDestinations = source.catalog.lookupMaybe(name('Dests'), PDFDict);
  for (const [key, value] of legacyDestinations?.entries() ?? []) {
    namedDestinations.set(key.decodeText(), value);
  }
  const nameTreeVisited = new Set<PDFDict>();
  const readDestinationTree = (tree: PDFDict) => {
    if (nameTreeVisited.has(tree)) return;
    nameTreeVisited.add(tree);
    const entries = tree.lookupMaybe(name('Names'), PDFArray);
    for (let index = 0; entries && index + 1 < entries.size(); index += 2) {
      namedDestinations.set(textOf(entries.lookup(index)), entries.get(index + 1));
    }
    for (const child of tree.lookupMaybe(name('Kids'), PDFArray)?.asArray() ?? []) {
      const node = source.context.lookup(child);
      if (node instanceof PDFDict) readDestinationTree(node);
    }
  };
  const tree = source.catalog.lookupMaybe(name('Names'), PDFDict)?.lookupMaybe(name('Dests'), PDFDict);
  if (tree) readDestinationTree(tree);

  // PDFObjectCopier follows links and annotation page pointers. Use the same page
  // reference map for every donor, then cut references to pages outside this copy.
  // Callers prune the now-detached objects before serializing the result.
  const finish = (fieldRoots: PDFObject[] = []) => {
    const resolveDestination = (value: PDFObject): PDFArray | undefined => {
      let target = destination.context.lookup(value);
      if (target instanceof PDFName || target instanceof PDFString || target instanceof PDFHexString) {
        const sourceTarget = namedDestinations.get(target.decodeText());
        if (!sourceTarget) return;
        target = destination.context.lookup(copier.copy(sourceTarget));
      }
      if (target instanceof PDFDict) target = target.lookup(name('D'));
      if (target instanceof PDFArray && retainedPageRefs.has(target.get(0) as PDFRef)) return target;
    };
    const visited = new Set<PDFObject>();
    const retain = (value: PDFObject): boolean => {
      const object = destination.context.lookup(value);
      if (!object) return true;
      if (object instanceof PDFDict && object.lookup(name('Type')) === name('Page') &&
          (!(value instanceof PDFRef) || !retainedPageRefs.has(value))) return false;
      if (object instanceof PDFDict && object.lookup(name('S')) === name('GoTo')) {
        const target = object.get(name('D'));
        const resolved = target && resolveDestination(target);
        if (!resolved) return false;
        object.set(name('D'), resolved);
      }
      if (visited.has(object)) return true;
      visited.add(object);
      if (object instanceof PDFDict) {
        if (object.lookup(name('Subtype')) === name('Link') && object.has(name('Dest'))) {
          const resolved = resolveDestination(object.get(name('Dest'))!);
          if (resolved) object.set(name('Dest'), resolved);
          else object.delete(name('Dest'));
        }
        for (const [key, child] of object.entries()) {
          if (!retain(child)) object.delete(key);
        }
      } else if (object instanceof PDFArray) {
        for (let index = object.size() - 1; index >= 0; index -= 1) {
          if (!retain(object.get(index))) object.remove(index);
        }
      } else if (object instanceof PDFStream) {
        retain(object.dict);
      }
      return true;
    };
    pages.forEach(page => retain(page.ref));
    fieldRoots.forEach(retain);
    return pages;
  };
  if (!sourceForm) return finish();

  const widgets = new Set<PDFDict>();
  for (const page of pages) {
    for (const reference of page.node.Annots()?.asArray() ?? []) {
      const annotation = destination.context.lookup(reference, PDFDict);
      if (annotation.lookup(name('Subtype')) === name('Widget')) {
        annotation.set(name('P'), page.ref);
        widgets.add(annotation);
      }
    }
  }

  const copiedForm = copier.copy(sourceForm);
  const retained = new Set<PDFDict>();
  const visited = new Set<PDFDict>();
  const allPages = new Set(indices).size === source.getPageCount();
  const keepField = (reference: unknown): boolean => {
    const field = destination.context.lookup(reference as PDFRef, PDFDict);
    if (visited.has(field)) return retained.has(field);
    visited.add(field);
    const kids = field.lookupMaybe(name('Kids'), PDFArray);
    if (kids) {
      for (let index = kids.size() - 1; index >= 0; index -= 1) {
        if (!keepField(kids.get(index))) kids.remove(index);
      }
    }
    const keep = widgets.has(field) || Boolean(kids?.size()) || (
      allPages && !kids && field.lookup(name('Subtype')) !== name('Widget')
    );
    if (keep) retained.add(field);
    return keep;
  };
  const roots = (copiedForm.lookupMaybe(name('Fields'), PDFArray)?.asArray() ?? []).filter(keepField);
  if (!roots.length) return finish();

  let targetForm = destination.catalog.lookupMaybe(name('AcroForm'), PDFDict);
  if (!targetForm) {
    targetForm = destination.context.obj({ Fields: [] });
    destination.catalog.set(name('AcroForm'), destination.context.register(targetForm));
  }
  const targetRoots = targetForm.lookup(name('Fields'), PDFArray);

  // Imported appearance streams keep their own resources. Default appearances also need
  // unique resource names, otherwise editing a field from PDF B can use PDF A's font.
  let targetResources = targetForm.lookupMaybe(name('DR'), PDFDict);
  if (!targetResources) {
    targetResources = destination.context.obj({});
    targetForm.set(name('DR'), targetResources);
  }
  const renamed = new Map<string, Map<string, string>>();
  for (const [category, value] of copiedForm.lookupMaybe(name('DR'), PDFDict)?.entries() ?? []) {
    const resources = destination.context.lookup(value);
    if (!(resources instanceof PDFDict)) {
      if (!targetResources.has(category)) targetResources.set(category, value);
      continue;
    }
    let targetCategory = targetResources.lookupMaybe(category, PDFDict);
    if (!targetCategory) {
      targetCategory = destination.context.obj({});
      targetResources.set(category, targetCategory);
    }
    for (const [key, resource] of resources.entries()) {
      let unique = key;
      for (let suffix = 2; targetCategory.has(unique); suffix += 1) {
        unique = name(`${key.decodeText()}_${suffix}`);
      }
      targetCategory.set(unique, resource);
      if (unique !== key) {
        const aliases = renamed.get(category.decodeText()) ?? new Map<string, string>();
        aliases.set(key.toString(), unique.toString());
        renamed.set(category.decodeText(), aliases);
      }
    }
  }
  const rewriteAppearance = (field: PDFDict) => {
    const appearance = textOf(field.lookup(name('DA')));
    const categories: Record<string, string> = {
      Tf: 'Font', gs: 'ExtGState', CS: 'ColorSpace', cs: 'ColorSpace', SCN: 'Pattern', scn: 'Pattern',
    };
    if (appearance) field.set(name('DA'), PDFString.of(appearance.replace(
      /(\/[^\s()[\]<>/%]+)(\s+(?:[-+\d.]+\s+)?(Tf|gs|CS|cs|SCN|scn)\b)/g,
      (_, token, suffix, operator) => `${renamed.get(categories[operator])?.get(token) ?? token}${suffix}`,
    )));
  };
  const rootNames = new Set(targetRoots.asArray().map(reference =>
    textOf(destination.context.lookup(reference, PDFDict).lookup(name('T')))));
  const fieldNames = new Set(targetRoots.asArray().flatMap(reference =>
    namesUnder(destination.context.lookup(reference, PDFDict))));
  for (const reference of roots) {
    const root = destination.context.lookup(reference, PDFDict);
    const originalName = textOf(root.lookup(name('T')));
    const descendants = namesUnder(root);
    let unique = originalName;
    const namesWith = (prefix: string) => descendants.map(value => originalName
      ? prefix + value.slice(originalName.length) : [prefix, value].filter(Boolean).join('.'));
    for (let suffix = 2;
      (unique && rootNames.has(unique)) || namesWith(unique).some(value => fieldNames.has(value));
      suffix += 1) unique = `${originalName || 'Imported'}_${suffix}`;
    if (unique !== originalName) root.set(name('T'), PDFHexString.fromText(unique));
    rootNames.add(unique);
    namesWith(unique).forEach(value => fieldNames.add(value));
    for (const key of ['DA', 'Q']) {
      if (!root.has(name(key)) && copiedForm.has(name(key))) root.set(name(key), copiedForm.get(name(key))!);
    }
    targetRoots.push(reference);
  }
  retained.forEach(rewriteAppearance);
  if (copiedForm.has(name('NeedAppearances'))) {
    targetForm.set(name('NeedAppearances'), copiedForm.get(name('NeedAppearances'))!);
  }
  const calculations = copiedForm.lookupMaybe(name('CO'), PDFArray)?.asArray().filter(reference =>
    retained.has(destination.context.lookup(reference, PDFDict))) ?? [];
  if (calculations.length) {
    const order = targetForm.lookupMaybe(name('CO'), PDFArray) ?? destination.context.obj([]);
    calculations.forEach(reference => order.push(reference));
    targetForm.set(name('CO'), order);
  }
  return finish(roots);
};
