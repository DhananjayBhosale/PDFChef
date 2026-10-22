import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useEffect, useMemo } from 'react';
import { useLocation } from 'react-router-dom';

interface RouteMeta {
  title: string;
  description: string;
  /** The URL that should rank when several paths render the same page. */
  canonical?: string;
  /** A device-local surface with nothing for a searcher to land on. */
  noindex?: boolean;
}

const defaultMeta: RouteMeta = {
  get title() { return t("route-seo.pdf.chef.private.pdf.tools.8f06d0"); },
  get description() { return t("route-seo.private.pdf.tools.that.run.in.your.92337d"); },
};

const routeMeta: Record<string, RouteMeta> = {
  '/': defaultMeta,
  '/view': {
    get title() { return t("route-seo.view.pdf.online.pdf.chef.8d526d"); },
    get description() { return t("route-seo.open.and.view.pdfs.privately.in.pdf.0bdd7c"); },
  },
  '/compress': {
    get title() { return t("route-seo.compress.pdf.reduce.file.size.online.pdf.45750e"); },
    get description() { return t("route-seo.reduce.pdf.size.with.browser.based.compression.07a74b"); },
  },
  '/merge': {
    get title() { return t("route-seo.merge.pdf.files.online.free.private.pdf.75355f"); },
    get description() { return t("route-seo.combine.multiple.pdfs.into.one.document.instantly.53813c"); },
  },
  '/split': {
    get title() { return t("route-seo.split.pdf.pages.extract.separate.online.pdf.535bfe"); },
    get description() { return t("route-seo.split.pdfs.by.selected.pages.all.pages.5ddd0b"); },
  },
  '/edit': {
    get title() { return t("route-seo.edit.pdf.fill.form.fields.and.add.489eb2"); },
    get description() { return t("route-seo.fill.detected.pdf.form.fields.or.place.5c191e"); },
  },
  '/pdf-to-jpg': {
    get title() { return t("route-seo.pdf.to.jpg.converter.export.pages.to.8e2e3a"); },
    get description() { return t("route-seo.convert.pdf.pages.to.jpg.png.or.91fd7b"); },
  },
  '/pdf-to-word': {
    get title() { return t("route-seo.pdf.to.word.export.pdf.text.to.11ecae"); },
    get description() { return t("route-seo.convert.the.searchable.text.layer.of.a.f239f6"); },
  },
  '/word-to-pdf': {
    get title() { return t("route-seo.word.to.pdf.convert.docx.locally.pdf.5834d7"); },
    get description() { return t("route-seo.convert.text.from.docx.word.files.into.fbf55b"); },
  },
  '/powerpoint-to-pdf': {
    get title() { return t("route-seo.powerpoint.to.pdf.convert.pptx.locally.pdf.38f12d"); },
    get description() { return t("route-seo.render.pptx.slides.to.pdf.at.their.13b0cf"); },
  },
  '/make-fillable': {
    get title() { return t("route-seo.make.pdf.fillable.form.field.detection.pdf.bc57bc"); },
    get description() { return t("route-seo.suggest.draw.review.and.export.real.fillable.a5c2be"); },
  },
  '/image-to-pdf': {
    get title() { return t("route-seo.jpg.to.pdf.converter.create.pdfs.from.b8e2b1"); },
    get description() { return t("route-seo.create.pdfs.from.images.with.drag.and.78e3d3"); },
  },
  '/make-pdf': {
    get title() { return t("route-seo.create.pdf.from.photos.camera.or.gallery.eaa4b3"); },
    get description() { return t("route-seo.capture.or.import.photos.and.build.a.f7b8c8"); },
  },
  '/sign': {
    get title() { return t("route-seo.sign.pdf.add.signature.image.pdf.chef.7b24df"); },
    get description() { return t("route-seo.draw.or.upload.your.signature.place.it.7ee9e2"); },
  },
  '/verify-signatures': {
    noindex: true,
    get title() { return t("route-seo.verify.pdf.signatures.pdf.chef.5d0a3e"); },
    get description() { return t("route-seo.check.pdf.digital.signatures.signer.trust.8b41c7"); },
  },
  '/delete-pages': {
    get title() { return t("route-seo.delete.pdf.pages.remove.unwanted.pages.pdf.453f32"); },
    get description() { return t("route-seo.select.and.remove.pdf.pages.visually.with.1bcc36"); },
  },
  '/reorder': {
    get title() { return t("route-seo.reorder.pdf.pages.drag.and.drop.sort.370395"); },
    get description() { return t("route-seo.rearrange.pdf.pages.with.drag.and.drop.b7d468"); },
  },
  '/rotate': {
    get title() { return t("route-seo.rotate.pdf.pages.batch.page.rotation.pdf.c98347"); },
    get description() { return t("route-seo.rotate.selected.or.all.pdf.pages.by.ce1d56"); },
  },
  '/protect': {
    get title() { return t("route-seo.protect.pdf.with.password.pdf.chef.38812c"); },
    get description() { return t("route-seo.encrypt.pdf.documents.with.a.password.locally.aff156"); },
  },
  '/unlock': {
    get title() { return t("route-seo.unlock.pdf.remove.password.pdf.chef.769a95"); },
    get description() { return t("route-seo.decrypt.password.protected.pdfs.locally.after.entering.a02e52"); },
  },
  '/extract': {
    get title() { return t("route-seo.extract.pdf.pages.export.selected.pages.pdf.425388"); },
    get description() { return t("route-seo.choose.exact.pages.and.export.them.into.3fac54"); },
  },
  '/metadata': {
    get title() { return t("route-seo.pdf.metadata.editor.title.author.keywords.pdf.f17df0"); },
    get description() { return t("route-seo.view.and.update.pdf.metadata.fields.like.8f87cc"); },
  },
  '/flatten': {
    get title() { return t("route-seo.flatten.pdf.forms.lock.form.fields.pdf.6dd71f"); },
    get description() { return t("route-seo.flatten.form.fields.into.static.content.to.6e88e3"); },
  },
  '/compare': {
    get title() { return t("route-seo.compare.pdf.files.multi.page.comparison.report.6cc472"); },
    get description() { return t("route-seo.compare.two.pdfs.page.by.page.and.b0da6e"); },
  },
  '/ocr': {
    get title() { return t("route-seo.ocr.pdf.extract.text.layer.or.run.f712c9"); },
    get description() { return t("route-seo.extract.text.from.pdf.text.layers.or.23f545"); },
  },
  '/watermark': {
    get title() { return t("route-seo.watermark.pdf.add.custom.text.watermark.pdf.f0df6a"); },
    get description() { return t("route-seo.apply.text.watermarks.with.custom.size.opacity.d73a7c"); },
  },
  '/page-numbers': {
    get title() { return t("route-seo.add.page.numbers.to.pdf.pdf.chef.a31ac5"); },
    get description() { return t("route-seo.add.custom.page.numbering.with.flexible.format.59b82c"); },
  },
  '/repair': {
    get title() { return t("route-seo.repair.pdf.re.save.for.compatibility.pdf.4b07f3"); },
    get description() { return t("route-seo.rebuild.and.re.save.pdfs.to.improve.4221a0"); },
  },
  '/crop': {
    get title() { return t("route-seo.crop.pdf.trim.page.margins.pdf.chef.dc79f2"); },
    get description() { return t("route-seo.crop.pdf.page.margins.privately.in.your.a9a309"); },
  },
  '/header-footer': {
    get title() { return t("route-seo.add.header.and.footer.to.pdf.pdf.447991"); },
    get description() { return t("route-seo.add.repeated.header.and.footer.text.with.098c26"); },
  },
  '/remove-metadata': {
    get title() { return t("route-seo.remove.pdf.metadata.pdf.chef.0cb227"); },
    get description() { return t("route-seo.strip.title.author.dates.viewer.preferences.and.1e7a08"); },
  },
  '/remove-annotations': {
    get title() { return t("route-seo.remove.pdf.annotations.pdf.chef.1ce315"); },
    get description() { return t("route-seo.remove.comments.annotations.markup.and.page.level.9f6df7"); },
  },
  '/remove-blank-pages': {
    get title() { return t("route-seo.remove.blank.pages.from.pdf.pdf.chef.bf1b58"); },
    get description() { return t("route-seo.detect.mostly.empty.pdf.pages.and.export.e35113"); },
  },
  '/extract-images': {
    get title() { return t("route-seo.extract.images.from.pdf.pdf.chef.b0ea47"); },
    get description() { return t("route-seo.find.embedded.images.in.pdf.files.and.225edc"); },
  },
  '/sanitize': {
    get title() { return t("route-seo.sanitize.pdf.clean.hidden.data.pdf.chef.7144ab"); },
    get description() { return t("route-seo.clean.metadata.and.annotations.from.pdfs.in.92ed55"); },
  },
  '/batch': {
    get title() { return t("route-seo.batch.pdf.processing.private.bulk.tools.pdf.28b30b"); },
    get description() { return t("route-seo.run.compression.conversion.security.metadata.page.and.1d8e45"); },
  },
  '/invoice': {
    get title() { return t("route-seo.free.invoice.maker.create.an.invoice.pdf.85bc0e"); },
    get description() { return t("route-seo.make.a.professional.invoice.pdf.in.your.c07941"); },
  },
  '/receipt': {
    get title() { return t("route-seo.free.receipt.maker.create.a.receipt.pdf.27f657"); },
    get description() { return t("route-seo.make.a.receipt.pdf.that.proves.a.a20157"); },
  },
  '/quote': {
    get title() { return t("route-seo.free.quote.maker.create.a.quote.or.a610f8"); },
    get description() { return t("route-seo.make.a.quote.or.estimate.pdf.for.211740"); },
  },
  '/recent': {
    noindex: true,
    get title() { return t("route-seo.local.output.history.pdf.chef.37c6f0"); },
    get description() { return t("route-seo.re.download.and.manage.pdf.chef.outputs.012332"); },
  },
  '/history': {
    noindex: true,
    canonical: '/recent',
    get title() { return t("route-seo.local.output.history.pdf.chef.37c6f0"); },
    get description() { return t("route-seo.re.download.and.manage.pdf.chef.outputs.012332"); },
  },
  '/settings': {
    noindex: true,
    get title() { return t("route-seo.settings.pdf.chef.4b3556"); },
    get description() { return t("route-seo.control.local.history.download.behavior.and.large.e227f1"); },
  },
  '/help': {
    get title() { return t("route-seo.pdf.chef.help.frequently.asked.questions.0c6d0c"); },
    get description() { return t("route-seo.answers.about.pdf.chef.whether.files.are.982c42"); },
  },
  '/privacy-policy': {
    canonical: '/privacy',
    get title() { return t("route-seo.privacy.policy.pdf.chef.f0035d"); },
    get description() { return t("route-seo.read.the.pdf.chef.privacy.policy.3812af"); },
  },
  '/privacy': {
    get title() { return t("route-seo.privacy.policy.pdf.chef.f0035d"); },
    get description() { return t("route-seo.read.the.pdf.chef.privacy.policy.for.a89265"); },
  },
  '/pdf-chef-privacy': {
    canonical: '/privacy',
    get title() { return t("route-seo.privacy.policy.pdf.chef.f0035d"); },
    get description() { return t("route-seo.read.the.pdf.chef.privacy.policy.covering.0cdf8e"); },
  },
  '/terms': {
    get title() { return t("route-seo.terms.and.conditions.pdf.chef.bff6d8"); },
    get description() { return t("route-seo.read.the.pdf.chef.terms.and.conditions.09c956"); },
  },
  '/terms-and-conditions': {
    canonical: '/terms',
    get title() { return t("route-seo.terms.and.conditions.pdf.chef.bff6d8"); },
    get description() { return t("route-seo.read.the.pdf.chef.terms.and.conditions.09c956"); },
  },
  // Reached from Settings. A list of dependencies is nothing for a searcher.
  '/licenses': {
    noindex: true,
    get title() { return t("settings-page.open.source.licenses.c9f6d0"); },
    get description() { return t("settings-page.open.source.licenses.c9f6d0"); },
  },
};

const upsertMetaTag = (name: string, content: string, property = false) => {
  const selector = property ? `meta[property="${name}"]` : `meta[name="${name}"]`;
  let element = document.querySelector(selector);

  if (!element) {
    element = document.createElement('meta');
    if (property) element.setAttribute('property', name);
    else element.setAttribute('name', name);
    document.head.appendChild(element);
  }

  element.setAttribute('content', content);
};

export const RouteSEO: React.FC = () => {
  const { revision } = useI18n();
  const location = useLocation();

  const normalizedPath = useMemo(() => {
    if (location.pathname === '/') return '/';
    return location.pathname.replace(/\/+$/, '');
  }, [location.pathname]);

  const meta = useMemo(() => {
    return routeMeta[normalizedPath] ?? defaultMeta;
  }, [normalizedPath]);

  useEffect(() => {
    const origin = typeof window !== 'undefined'
      ? window.location.origin
      : 'https://pdfchef.dhananjaytech.app';
    const canonicalPath = meta.canonical ?? (normalizedPath === '/' ? '/' : normalizedPath);
    const canonicalUrl = `${origin}${canonicalPath}`;

    document.title = meta.title;

    upsertMetaTag('description', meta.description);
    upsertMetaTag('og:title', meta.title, true);
    upsertMetaTag('og:description', meta.description, true);
    upsertMetaTag('og:url', canonicalUrl, true);
    upsertMetaTag('twitter:title', meta.title, true);
    upsertMetaTag('twitter:description', meta.description, true);
    upsertMetaTag('twitter:url', canonicalUrl, true);

    let linkCanonical = document.querySelector('link[rel="canonical"]');
    if (!linkCanonical) {
      linkCanonical = document.createElement('link');
      linkCanonical.setAttribute('rel', 'canonical');
      document.head.appendChild(linkCanonical);
    }
    linkCanonical.setAttribute('href', canonicalUrl);
    upsertMetaTag('robots', meta.noindex ? 'noindex, follow' : 'index, follow');
  }, [normalizedPath, meta, revision]);

  return null;
};
